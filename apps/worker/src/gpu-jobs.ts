import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { chargeUsageDelta, managedGpuFundingShortfall } from "@openmetal/billing";
import { GPU_JOB_DEFAULT_MAX_START_SECONDS, GPU_JOB_MAX_LOG_BYTES } from "@openmetal/contracts";
import {
  gpuCostReconciliations,
  gpuJobLogEvents,
  gpuJobs,
  insertDomainEventAndBroadcast,
  operations,
  organizationProviderCredentials,
  outboxJobs,
  providerAttempts,
  providerCostSnapshots,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import { projectTopic, type GpuJobCancelReason } from "@openmetal/events";
import {
  GPU_OFFERS,
  ProviderError,
  findGpuOffer,
  type GpuJobProvider,
  type GpuJobProviderName,
  type GpuRegion,
  type GpuType,
  type ProviderGpuJob,
  type ProviderGpuJobBucketMount,
  type ProviderGpuJobLogStream,
  type ProviderGpuJobRegistryAuth,
  type ProviderGpuJobStatus,
  type ProviderSandboxCost,
} from "@openmetal/provider-core";
import {
  appendOperationEvent,
  classifyProviderFailure,
  safeError,
  setOperationState,
} from "./common.js";
import {
  getByokGpuJobProviderByCredentialId,
  listOrganizationByokGpuJobProviders,
  type ResolvedByokGpuJobProvider,
} from "./provider-credentials.js";

export type GpuJobProviders = Partial<Record<GpuJobProviderName, GpuJobProvider>>;
export type GpuJobHandlerResult = { rescheduleAt?: Date } | void;
export type GpuJobWorkerOptions = {
  monitorIntervalMs: number;
  onCostError?: (error: unknown) => void;
  onLogError?: (error: unknown) => void;
};

type GpuJobRow = typeof gpuJobs.$inferSelect;
type TerminalGpuJobState = "succeeded" | "failed" | "timed_out" | "cancelled";
type ProviderTerminalStatus = Exclude<ProviderGpuJobStatus, { state: "running" | "pending" }>;
type GpuJobEventType =
  | "gpu_job.started"
  | "gpu_job.attempt_failed"
  | "gpu_job.cost_updated"
  | "gpu_job.succeeded"
  | "gpu_job.failed"
  | "gpu_job.timed_out"
  | "gpu_job.cancelled";

const TERMINAL_STATES: readonly TerminalGpuJobState[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
];
const TERMINAL_EVENTS: Record<TerminalGpuJobState, GpuJobEventType> = {
  succeeded: "gpu_job.succeeded",
  failed: "gpu_job.failed",
  timed_out: "gpu_job.timed_out",
  cancelled: "gpu_job.cancelled",
};
const SUBMIT_TIMEOUT_MS = 120_000;
const PROVIDER_CALL_TIMEOUT_MS = 30_000;
const LOG_WAIT_MS = 2_000;
const LOG_PASS_MAX_BYTES = 1_048_576;
const LOG_EVENT_MAX_BYTES = 262_144;
const LOG_DRAIN_PASSES = 3;
const COST_SYNC_INTERVAL_MS = 30_000;
const DEADLINE_GRACE_MS = 60_000;
const FINAL_COST_DELAYS_MS = [2 * 60_000, 10 * 60_000] as const;
const STALE_CANCEL_MS = 5 * 60_000;
const CAPACITY_RETRY_MS = 10_000;
const PROVIDER_TIMEOUT_GRACE_SECONDS = 120;
// Submits can be slow to settle, so a provider resource is only treated as
// leaked once it has existed this long without a matching live job.
const ORPHAN_MIN_AGE_MS = 15 * 60_000;
const ORPHAN_SWEEP_TIMEOUT_MS = 120_000;
// Providers keep a finished container's logs available for a while; stop
// retrying an incomplete drain after this long.
const TERMINAL_LOG_DRAIN_MS = 10 * 60_000;

function isTerminal(state: string): state is TerminalGpuJobState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

function projectPublicId(projectId: string): string {
  return `prj_${projectId.replaceAll("-", "")}`;
}

async function loadGpuJob(db: MetalDb, gpuJobId: string): Promise<GpuJobRow | undefined> {
  return db
    .select()
    .from(gpuJobs)
    .where(eq(gpuJobs.id, gpuJobId))
    .then((rows) => rows[0]);
}

async function recordGpuJobEvent(
  tx: MetalDb,
  job: GpuJobRow,
  type: GpuJobEventType,
  data: Record<string, unknown> = {},
) {
  await insertDomainEventAndBroadcast(tx, {
    type,
    organizationId: job.organizationId,
    projectId: job.projectId,
    actorId: job.createdBy,
    data: { gpu_job_id: job.publicId, ...data },
    occurredAt: new Date(),
    topic: projectTopic(projectPublicId(job.projectId)),
  });
}

// Monitors resolve their provider every few seconds, so BYOK clients are reused
// until the credential is rotated rather than rebuilt with new connections.
const byokProviderCache = new Map<string, { updatedAt: number; provider: GpuJobProvider }>();

async function byokGpuJobProvider(db: MetalDb, credentialId: string): Promise<GpuJobProvider> {
  const [credential] = await db
    .select({ updatedAt: organizationProviderCredentials.updatedAt })
    .from(organizationProviderCredentials)
    .where(eq(organizationProviderCredentials.id, credentialId));
  const updatedAt = credential?.updatedAt.getTime() ?? 0;
  const cached = byokProviderCache.get(credentialId);
  if (cached && cached.updatedAt === updatedAt) return cached.provider;
  const provider = await getByokGpuJobProviderByCredentialId(db, credentialId);
  byokProviderCache.set(credentialId, { updatedAt, provider });
  return provider;
}

export async function resolveGpuJobProvider(
  db: MetalDb,
  providers: GpuJobProviders,
  job: Pick<GpuJobRow, "provider" | "providerCredentialId">,
): Promise<GpuJobProvider> {
  if (job.providerCredentialId) {
    return byokGpuJobProvider(db, job.providerCredentialId);
  }
  const provider = job.provider ? providers[job.provider as GpuJobProviderName] : undefined;
  if (!provider) {
    throw new Error(`${job.provider ?? "unknown"} GPU job provider is not configured`);
  }
  return provider;
}

type JobCredentials = {
  environment: Record<string, string>;
  registry: Record<string, string> | null;
  mounts: Array<Record<string, string>>;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function parseJobCredentials(value: unknown): JobCredentials | null {
  // Jobs created before registry and mount credentials stored a flat secret map.
  if (isStringRecord(value)) return { environment: value, registry: null, mounts: [] };
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) {
    return null;
  }
  const { environment, registry, mounts } = value as Record<string, unknown>;
  if (!isStringRecord(environment)) return null;
  if (registry !== null && !isStringRecord(registry)) return null;
  if (!Array.isArray(mounts) || !mounts.every(isStringRecord)) return null;
  return { environment, registry, mounts };
}

async function readJobCredentials(db: MetalDb, job: GpuJobRow): Promise<JobCredentials> {
  const source = job.source as { registry_auth?: unknown };
  if (!job.secretsVaultId) {
    if (job.secretNames.length > 0 || source.registry_auth || job.mounts.length > 0) {
      throw new ProviderError("GPU job secrets are no longer available", "invalid_request", false);
    }
    return { environment: {}, registry: null, mounts: [] };
  }
  const rows = (await db.execute(sql`
    select decrypted_secret as "decryptedSecret"
    from vault.decrypted_secrets
    where id = ${job.secretsVaultId}
    limit 1
  `)) as unknown as Array<{ decryptedSecret: string }>;
  const parsed = parseJobCredentials(JSON.parse(rows[0]?.decryptedSecret ?? "null"));
  if (!parsed || parsed.mounts.length !== job.mounts.length) {
    throw new ProviderError("GPU job secrets could not be decrypted", "invalid_request", false);
  }
  return parsed;
}

function registryAuthFor(
  job: GpuJobRow,
  credentials: JobCredentials,
): ProviderGpuJobRegistryAuth | undefined {
  const registry = credentials.registry;
  if (!registry) return undefined;
  switch (registry.kind) {
    case "basic":
      return { kind: "basic", username: registry.username!, password: registry.password! };
    case "aws_ecr":
      return {
        kind: "aws_ecr",
        accessKeyId: registry.access_key_id!,
        secretAccessKey: registry.secret_access_key!,
        region: registry.region!,
      };
    case "gcp_artifact_registry":
      return { kind: "gcp_artifact_registry", serviceAccountJson: registry.service_account_json! };
    default:
      throw new ProviderError(
        `GPU job ${job.publicId} has an unknown registry credential`,
        "invalid_request",
        false,
      );
  }
}

function bucketMountsFor(job: GpuJobRow, credentials: JobCredentials): ProviderGpuJobBucketMount[] {
  return job.mounts.map((stored, index) => {
    const mount = stored as {
      provider: "s3" | "r2" | "gcs";
      bucket: string;
      mount_path: string;
      key_prefix?: string;
      endpoint_url?: string;
      region?: string;
      read_only?: boolean;
    };
    const secret = credentials.mounts[index]!;
    return {
      provider: mount.provider,
      bucket: mount.bucket,
      mountPath: mount.mount_path,
      keyPrefix: mount.key_prefix,
      endpointUrl: mount.endpoint_url,
      region: mount.region,
      readOnly: mount.read_only === true,
      credentials: {
        accessKeyId: secret.access_key_id!,
        secretAccessKey: secret.secret_access_key!,
        ...(secret.session_token ? { sessionToken: secret.session_token } : {}),
      },
    };
  });
}

async function purgeSecrets(tx: MetalDb, gpuJobId: string) {
  await tx.execute(sql`select metal.purge_gpu_job_secrets(${gpuJobId})`);
}

async function scheduleMonitor(tx: MetalDb, gpuJobId: string, availableAt: Date) {
  const now = new Date();
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "gpu_job.monitor",
      dedupeKey: `gpu_job:monitor:${gpuJobId}`,
      payload: { job_type: "gpu_job.monitor", gpu_job_id: gpuJobId },
      availableAt,
    })
    .onConflictDoUpdate({
      target: outboxJobs.dedupeKey,
      set: {
        status: "pending",
        attemptCount: 0,
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseToken: null,
        lastError: null,
        completedAt: null,
        updatedAt: now,
      },
      setWhere: sql`${outboxJobs.status} in ('succeeded', 'failed')`,
    });
}

async function scheduleCostSync(tx: MetalDb, gpuJobId: string, availableAt: Date, final: boolean) {
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "gpu_job.cost.sync",
      dedupeKey: `gpu_job:cost:${gpuJobId}:${availableAt.getTime()}:${final}`,
      payload: { job_type: "gpu_job.cost.sync", gpu_job_id: gpuJobId, final },
      availableAt,
    })
    .onConflictDoNothing();
}

async function enqueueCancel(
  tx: MetalDb,
  gpuJobId: string,
  reason: GpuJobCancelReason,
  operationId?: string,
) {
  const now = new Date();
  const payload = {
    job_type: "gpu_job.cancel",
    gpu_job_id: gpuJobId,
    reason,
    ...(operationId ? { operation_id: operationId } : {}),
  };
  await tx
    .insert(outboxJobs)
    .values({ jobType: "gpu_job.cancel", dedupeKey: `gpu_job:cancel:${gpuJobId}`, payload })
    .onConflictDoUpdate({
      target: outboxJobs.dedupeKey,
      set: {
        payload,
        status: "pending",
        attemptCount: 0,
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseToken: null,
        lastError: null,
        completedAt: null,
        updatedAt: now,
      },
      setWhere: sql`${outboxJobs.status} <> 'leased'`,
    });
}

/** Moves a running job to cancelling on behalf of the platform and queues its termination. */
async function requestSystemCancel(tx: MetalDb, job: GpuJobRow, reason: GpuJobCancelReason) {
  const now = new Date();
  const [updated] = await tx
    .update(gpuJobs)
    .set({ state: "cancelling", cancelRequestedAt: now, cancelReason: reason })
    .where(and(eq(gpuJobs.id, job.id), inArray(gpuJobs.state, ["provisioning", "running"])))
    .returning({ id: gpuJobs.id });
  if (!updated) return;
  const operationId = crypto.randomUUID();
  await tx.insert(operations).values({
    id: operationId,
    publicId: `op_${operationId.replaceAll("-", "")}`,
    organizationId: job.organizationId,
    projectId: job.projectId,
    gpuJobId: job.id,
    type: "gpu_job_cancel",
    state: "queued",
  });
  await appendOperationEvent(tx, operationId, "queued", { reason });
  await enqueueCancel(tx, job.id, reason, operationId);
}

async function completeOpenOperations(tx: MetalDb, gpuJobId: string, createState: string) {
  const open = await tx
    .select({ id: operations.id, type: operations.type })
    .from(operations)
    .where(
      and(
        eq(operations.gpuJobId, gpuJobId),
        inArray(operations.state, ["queued", "running", "reconciling"]),
      ),
    );
  for (const operation of open) {
    await setOperationState(
      tx,
      operation.id,
      operation.type === "gpu_job_create" ? createState : "succeeded",
    );
  }
}

async function cancelBeforeStart(db: MetalDb, job: GpuJobRow, reason: GpuJobCancelReason) {
  await withTransaction(db, async (tx) => {
    const now = new Date();
    const [cancelled] = await tx
      .update(gpuJobs)
      .set({
        state: "cancelled",
        stateReason: job.cancelReason ?? reason,
        cancelRequestedAt: job.cancelRequestedAt ?? now,
        cancelReason: job.cancelReason ?? reason,
        logsComplete: true,
        finishedAt: now,
      })
      .where(and(eq(gpuJobs.id, job.id), inArray(gpuJobs.state, ["requested", "cancelling"])))
      .returning();
    if (!cancelled) return;
    await purgeSecrets(tx, job.id);
    await completeOpenOperations(tx, job.id, "cancelled");
    await recordGpuJobEvent(tx, cancelled, "gpu_job.cancelled", {
      reason: cancelled.stateReason,
    });
  });
}

async function failBeforeStart(
  db: MetalDb,
  job: GpuJobRow,
  operationId: string,
  failure: { code: string; message: string },
) {
  await withTransaction(db, async (tx) => {
    const now = new Date();
    const [failed] = await tx
      .update(gpuJobs)
      .set({
        state: "failed",
        stateReason: failure.code,
        failureCode: failure.code,
        failureMessage: failure.message,
        logsComplete: true,
        finishedAt: now,
      })
      .where(
        and(
          eq(gpuJobs.id, job.id),
          inArray(gpuJobs.state, ["requested", "provisioning", "provision_unknown"]),
        ),
      )
      .returning();
    if (!failed) return;
    await purgeSecrets(tx, job.id);
    await recordGpuJobEvent(tx, failed, "gpu_job.failed", { reason: failure.code });
  });
  await setOperationState(db, operationId, "failed", {
    code: failure.code,
    message: failure.message,
    retryable: false,
  });
}

type Candidate = {
  name: GpuJobProviderName;
  provider?: GpuJobProvider;
  credentialId: string | null;
  invalidCredential: boolean;
};

async function gpuJobCandidates(
  db: MetalDb,
  providers: GpuJobProviders,
  job: GpuJobRow,
): Promise<Candidate[]> {
  const byok: Partial<Record<GpuJobProviderName, ResolvedByokGpuJobProvider>> =
    await listOrganizationByokGpuJobProviders(db, job.organizationId);
  const offered = [
    ...new Set(
      GPU_OFFERS.filter((offer) => offer.gpuType === job.gpu.type).map((offer) => offer.provider),
    ),
  ];
  const names =
    job.primaryProvider === "auto"
      ? offered
      : offered.filter((provider) => provider === job.primaryProvider);
  return names.map((name) => {
    const credential = byok[name];
    return {
      name,
      provider: credential ? credential.provider : providers[name],
      credentialId: credential?.credentialId ?? null,
      invalidCredential: credential?.invalid === true,
    };
  });
}

function startDeadline(job: Pick<GpuJobRow, "createdAt" | "lifecycle">): Date {
  const seconds = job.lifecycle.max_start_seconds ?? GPU_JOB_DEFAULT_MAX_START_SECONDS;
  return new Date(job.createdAt.getTime() + seconds * 1_000);
}

function submitInputFor(job: GpuJobRow, credentials: JobCredentials, providerName: string) {
  const source = job.source as { image: string; command: string[]; working_dir?: string };
  const resources = job.resources as { vcpu?: number; memory_mb?: number };
  const providerOptions = (job.providerOptions as Record<string, Record<string, unknown>>)[
    providerName
  ];
  const remainingStartSeconds = Math.max(
    0,
    Math.ceil((startDeadline(job).getTime() - Date.now()) / 1_000),
  );
  return {
    metalGpuJobId: job.publicId,
    organizationId: job.organizationId,
    projectId: job.projectId,
    image: source.image,
    command: source.command,
    workingDir: source.working_dir,
    gpu: { type: job.gpu.type as GpuType, count: job.gpu.count },
    resources: { vcpu: resources.vcpu, memoryMb: resources.memory_mb },
    regions: (job.placement.regions ?? []) as GpuRegion[],
    maxRuntimeSeconds: job.lifecycle.max_runtime_seconds,
    providerTimeoutSeconds:
      job.lifecycle.max_runtime_seconds + remainingStartSeconds + PROVIDER_TIMEOUT_GRACE_SECONDS,
    environment: job.environment,
    secrets: credentials.environment,
    registryAuth: registryAuthFor(job, credentials),
    bucketMounts: bucketMountsFor(job, credentials),
    providerOptions: providerOptions ?? {},
  };
}

async function adoptProviderJob(
  db: MetalDb,
  job: GpuJobRow,
  candidate: Candidate,
  attemptId: string,
  remote: ProviderGpuJob,
  operationId: string,
  outcome: "created" | "found",
) {
  await withTransaction(db, async (tx) => {
    const now = new Date();
    await tx
      .update(providerAttempts)
      .set({
        state: "succeeded",
        providerResourceId: remote.providerResourceId,
        providerMetadata: remote.providerMetadata ?? {},
        resolvedResources: remote.resolved,
        outcome,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(providerAttempts.id, attemptId));
    const [current] = await tx
      .select({ state: gpuJobs.state })
      .from(gpuJobs)
      .where(eq(gpuJobs.id, job.id))
      .for("update");
    const cancelRequested = current?.state === "cancelling";
    // The provider accepted the job but may still be waiting for GPUs; the
    // monitor moves it to running once a container starts.
    const [updated] = await tx
      .update(gpuJobs)
      .set({
        provider: candidate.name,
        providerCredentialId: candidate.credentialId,
        billingMode: candidate.credentialId ? "byok" : "managed",
        providerResourceId: remote.providerResourceId,
        providerOrganizationId: remote.providerOrganizationId,
        providerMetadata: remote.providerMetadata ?? {},
        resolved: remote.resolved,
        state: cancelRequested ? "cancelling" : "provisioning",
        stateReason: null,
        submittedAt: now,
        failureCode: null,
        failureMessage: null,
      })
      .where(eq(gpuJobs.id, job.id))
      .returning();
    if (!updated) return;
    await scheduleMonitor(tx, job.id, new Date(now.getTime() + 2_000));
  });
  await setOperationState(db, operationId, "succeeded");
}

/** Records the container start and measures the runtime limit from it. */
async function markGpuJobStarted(db: MetalDb, job: GpuJobRow) {
  await withTransaction(db, async (tx) => {
    const now = new Date();
    const deadlineAt = new Date(now.getTime() + job.lifecycle.max_runtime_seconds * 1_000);
    const [started] = await tx
      .update(gpuJobs)
      .set({ state: "running", startedAt: now, deadlineAt })
      .where(and(eq(gpuJobs.id, job.id), eq(gpuJobs.state, "provisioning")))
      .returning();
    if (!started) {
      await tx
        .update(gpuJobs)
        .set({ startedAt: now })
        .where(and(eq(gpuJobs.id, job.id), isNull(gpuJobs.startedAt)));
      return;
    }
    await recordGpuJobEvent(tx, started, "gpu_job.started", {
      provider: started.provider,
      gpu_type: job.gpu.type,
      gpu_count: job.gpu.count,
    });
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "gpu_job.cancel",
        dedupeKey: `gpu_job:deadline:${job.id}`,
        payload: {
          job_type: "gpu_job.cancel",
          gpu_job_id: job.id,
          reason: "max_runtime_exceeded",
        },
        availableAt: new Date(deadlineAt.getTime() + DEADLINE_GRACE_MS),
      })
      .onConflictDoNothing();
  });
}

export type GpuJobCapacityLimits = {
  maxManagedGpusPerOrganization: number;
  maxManagedGpus?: number;
};

type CapacityClaim =
  | { claimed: true; job: GpuJobRow }
  | { claimed: false; reason: "waiting_for_organization_gpu_limit" | "waiting_for_gpu_capacity" }
  | { claimed: false; reason: "insufficient_credits"; message: string }
  | { claimed: false; reason: "gone" };

const ACTIVE_MANAGED_STATES = ["provisioning", "provision_unknown", "running", "cancelling"];

/**
 * Reserves managed GPU capacity by moving the job to provisioning. A single
 * advisory lock serializes claims so concurrent workers cannot overshoot caps.
 */
async function claimManagedCapacity(
  db: MetalDb,
  job: GpuJobRow,
  limits: GpuJobCapacityLimits,
): Promise<CapacityClaim> {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('metal:gpu_job_capacity'))`);
    const [counts] = await tx
      .select({
        organization: sql<string>`coalesce(sum((${gpuJobs.gpu} ->> 'count')::int) filter (where ${gpuJobs.organizationId} = ${job.organizationId}), 0)::text`,
        total: sql<string>`coalesce(sum((${gpuJobs.gpu} ->> 'count')::int), 0)::text`,
      })
      .from(gpuJobs)
      .where(
        and(
          eq(gpuJobs.billingMode, "managed"),
          inArray(gpuJobs.state, ACTIVE_MANAGED_STATES),
          ne(gpuJobs.id, job.id),
        ),
      );
    const organizationGpus = Number(counts?.organization ?? 0);
    const totalGpus = Number(counts?.total ?? 0);
    if (organizationGpus + job.gpu.count > limits.maxManagedGpusPerOrganization) {
      return { claimed: false, reason: "waiting_for_organization_gpu_limit" };
    }
    if (limits.maxManagedGpus !== undefined && totalGpus + job.gpu.count > limits.maxManagedGpus) {
      return { claimed: false, reason: "waiting_for_gpu_capacity" };
    }
    const shortfall = await managedGpuFundingShortfall(tx, job.organizationId, {
      hourlyMicrousd: job.estimatedHourlyMicrousd,
      excludeGpuJobId: job.id,
    });
    if (shortfall) {
      return {
        claimed: false,
        reason: "insufficient_credits",
        message: `the organization balance does not cover ${shortfall.windowSeconds / 60} minutes of its managed GPU jobs`,
      };
    }
    const [claimed] = await tx
      .update(gpuJobs)
      .set({ state: "provisioning", billingMode: "managed", stateReason: null })
      .where(and(eq(gpuJobs.id, job.id), eq(gpuJobs.state, "requested")))
      .returning();
    return claimed ? { claimed: true, job: claimed } : { claimed: false, reason: "gone" };
  });
}

export const DEFAULT_GPU_JOB_CAPACITY_LIMITS: GpuJobCapacityLimits = {
  maxManagedGpusPerOrganization: 8,
};

export async function submitGpuJob(
  db: MetalDb,
  providers: GpuJobProviders,
  gpuJobId: string,
  operationId: string,
  limits: GpuJobCapacityLimits = DEFAULT_GPU_JOB_CAPACITY_LIMITS,
): Promise<GpuJobHandlerResult> {
  const existing = await loadGpuJob(db, gpuJobId);
  if (!existing || isTerminal(existing.state)) {
    if (existing?.state === "cancelled") await setOperationState(db, operationId, "cancelled");
    return;
  }
  if (existing.providerResourceId) {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  if (existing.state === "cancelling") {
    await settleCancelledSubmit(db, providers, existing, operationId);
    return;
  }
  const candidates = await gpuJobCandidates(db, providers, existing);
  let job: GpuJobRow | undefined;
  if (existing.state === "requested" && candidates[0] && !candidates[0].credentialId) {
    if (existing.gpu.count > limits.maxManagedGpusPerOrganization) {
      await failBeforeStart(db, existing, operationId, {
        code: "gpu_limit_exceeded",
        message: `managed GPU jobs can use at most ${limits.maxManagedGpusPerOrganization} GPUs per organization at a time`,
      });
      return;
    }
    const claim = await claimManagedCapacity(db, existing, limits);
    if (!claim.claimed) {
      if (claim.reason === "gone") return;
      if (claim.reason === "insufficient_credits") {
        await failBeforeStart(db, existing, operationId, {
          code: "insufficient_credits",
          message: claim.message,
        });
        return;
      }
      if (Date.now() >= startDeadline(existing).getTime()) {
        await failBeforeStart(db, existing, operationId, {
          code: "start_deadline_exceeded",
          message: `managed GPU capacity did not become available within max_start_seconds (${existing.lifecycle.max_start_seconds ?? GPU_JOB_DEFAULT_MAX_START_SECONDS})`,
        });
        return;
      }
      if (existing.stateReason !== claim.reason) {
        await db
          .update(gpuJobs)
          .set({ stateReason: claim.reason })
          .where(and(eq(gpuJobs.id, existing.id), eq(gpuJobs.state, "requested")));
      }
      return { rescheduleAt: new Date(Date.now() + CAPACITY_RETRY_MS) };
    }
    job = claim.job;
  } else {
    [job] = await db
      .update(gpuJobs)
      .set({ state: "provisioning", stateReason: null })
      .where(
        and(
          eq(gpuJobs.id, gpuJobId),
          inArray(gpuJobs.state, ["requested", "provisioning", "provision_unknown"]),
        ),
      )
      .returning();
  }
  if (!job) return;
  await setOperationState(db, operationId, "running");

  let credentials: JobCredentials;
  try {
    credentials = await readJobCredentials(db, job);
  } catch (error) {
    await failBeforeStart(db, job, operationId, {
      code: "secrets_unavailable",
      message: safeError(error),
    });
    return;
  }
  let lastFailure: { code: string; message: string } | undefined;

  for (const [attemptIndex, candidate] of candidates.entries()) {
    const [previous] = await db
      .select()
      .from(providerAttempts)
      .where(
        and(
          eq(providerAttempts.operationId, operationId),
          eq(providerAttempts.attemptIndex, attemptIndex),
        ),
      );
    if (previous?.state === "failed") {
      lastFailure = {
        code: previous.errorCode ?? "provider_error",
        message: previous.errorMessage ?? "provider attempt failed",
      };
      continue;
    }
    const [attempt] = await db
      .insert(providerAttempts)
      .values({
        operationId,
        gpuJobId: job.id,
        attemptIndex,
        provider: candidate.name,
        providerCredentialId: candidate.credentialId,
        state: "running",
        startedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [providerAttempts.operationId, providerAttempts.attemptIndex],
        set: { providerCredentialId: candidate.credentialId, updatedAt: new Date() },
      })
      .returning();
    const failAttempt = async (code: string, message: string, outcome = "ineligible") => {
      lastFailure = { code, message };
      await db
        .update(providerAttempts)
        .set({
          state: "failed",
          errorCode: code,
          errorMessage: message,
          outcome,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      await appendOperationEvent(db, operationId, "attempt_failed", {
        attempt_index: attemptIndex,
        provider: candidate.name,
        code,
      });
    };
    const provider = candidate.provider;
    if (candidate.invalidCredential || !provider) {
      await failAttempt(
        candidate.invalidCredential ? "provider_auth_error" : "provider_not_configured",
        `${candidate.name} GPU jobs are not available`,
      );
      continue;
    }
    if (!candidate.credentialId && !provider.capabilities.cost) {
      await failAttempt(
        "capability_unsupported",
        `${candidate.name} does not expose durable cost for managed billing`,
      );
      continue;
    }
    const offer = findGpuOffer(candidate.name, job.gpu.type as GpuType);
    if (
      !offer ||
      job.gpu.count > offer.maxCount ||
      job.lifecycle.max_runtime_seconds > offer.maxRuntimeSeconds
    ) {
      await failAttempt(
        "capability_unsupported",
        `${candidate.name} cannot run ${job.gpu.count} ${job.gpu.type} GPUs for ${job.lifecycle.max_runtime_seconds} seconds`,
      );
      continue;
    }
    const input = submitInputFor(job, credentials, candidate.name);
    await appendOperationEvent(db, operationId, "attempt_started", {
      attempt_index: attemptIndex,
      provider: candidate.name,
    });

    if (previous?.state === "reconciling") {
      let reconciled: ProviderGpuJob | null;
      try {
        reconciled = await provider.reconcileSubmit({
          ...input,
          signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
        });
      } catch (error) {
        // The earlier submit may still have created the job; keep reconciling
        // instead of letting retries exhaust into a failure.
        await markSubmitUnknown(db, job.id, operationId, safeError(error));
        throw new ProviderError(
          "GPU job submit reconciliation did not complete",
          "unknown_outcome",
          true,
        );
      }
      if (reconciled) {
        await adoptProviderJob(db, job, candidate, attempt!.id, reconciled, operationId, "found");
        return;
      }
    }

    try {
      const remote = await provider.submit({
        ...input,
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
      await adoptProviderJob(db, job, candidate, attempt!.id, remote, operationId, "created");
      return;
    } catch (error) {
      const classification = classifyProviderFailure(error);
      const message = safeError(error);
      await db
        .update(providerAttempts)
        .set({
          state: classification.unknown ? "reconciling" : "failed",
          errorCode: classification.kind,
          errorMessage: message,
          outcome: classification.unknown ? "unknown" : "absent",
          completedAt: classification.unknown ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      await appendOperationEvent(db, operationId, "attempt_failed", {
        attempt_index: attemptIndex,
        provider: candidate.name,
        code: classification.kind,
      });
      await withTransaction(db, (tx) =>
        recordGpuJobEvent(tx, job, "gpu_job.attempt_failed", {
          provider: candidate.name,
          code: classification.kind,
        }),
      );
      lastFailure = { code: classification.kind, message };
      if (classification.unknown) {
        let reconciled: ProviderGpuJob | null = null;
        let reconciliationCompleted = false;
        try {
          reconciled = await provider.reconcileSubmit({
            ...input,
            signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
          });
          reconciliationCompleted = true;
        } catch {
          reconciliationCompleted = false;
        }
        if (reconciled) {
          await adoptProviderJob(db, job, candidate, attempt!.id, reconciled, operationId, "found");
          return;
        }
        if (!reconciliationCompleted) {
          await markSubmitUnknown(db, job.id, operationId, message);
          throw new ProviderError(
            "GPU job submit reconciliation did not complete",
            "unknown_outcome",
            true,
          );
        }
        await db
          .update(providerAttempts)
          .set({ state: "failed", outcome: "absent", completedAt: new Date() })
          .where(eq(providerAttempts.id, attempt!.id));
        continue;
      }
      if (!classification.fallbackSafe) break;
    }
  }

  const current = await loadGpuJob(db, job.id);
  if (current?.state === "cancelling") {
    await cancelBeforeStart(db, current, "cancelled_by_user");
    return;
  }
  await failBeforeStart(
    db,
    job,
    operationId,
    lastFailure && candidates.length === 1
      ? lastFailure
      : {
          code: "no_eligible_provider",
          message: lastFailure
            ? `all selected providers failed or were ineligible: ${lastFailure.message}`
            : "no configured provider can run this GPU job",
        },
  );
}

/**
 * A job cancelled while its submit outcome was unknown may still have started
 * on the provider. Find it before settling so it is terminated, not leaked.
 */
async function markSubmitUnknown(
  db: MetalDb,
  gpuJobId: string,
  operationId: string,
  message: string,
) {
  await db
    .update(gpuJobs)
    .set({ state: "provision_unknown" })
    .where(and(eq(gpuJobs.id, gpuJobId), eq(gpuJobs.state, "provisioning")));
  await setOperationState(db, operationId, "reconciling", {
    code: "provider_unknown_outcome",
    message,
    retryable: true,
  });
}

async function settleCancelledSubmit(
  db: MetalDb,
  providers: GpuJobProviders,
  job: GpuJobRow,
  operationId: string,
) {
  const uncertain = await db
    .select()
    .from(providerAttempts)
    .where(
      and(eq(providerAttempts.operationId, operationId), eq(providerAttempts.state, "reconciling")),
    );
  if (uncertain.length > 0) {
    const candidates = await gpuJobCandidates(db, providers, job);
    for (const attempt of uncertain) {
      const candidate = candidates.find((item) => item.name === attempt.provider);
      if (!candidate?.provider) continue;
      const reconciled = await candidate.provider.reconcileSubmit({
        metalGpuJobId: job.publicId,
        gpu: { type: job.gpu.type as GpuType, count: job.gpu.count },
        resources: {},
        signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
      });
      if (reconciled) {
        await adoptProviderJob(db, job, candidate, attempt.id, reconciled, operationId, "found");
        await enqueueCancel(
          db,
          job.id,
          (job.cancelReason as GpuJobCancelReason | null) ?? "cancelled_by_user",
        );
        return;
      }
      await db
        .update(providerAttempts)
        .set({ state: "failed", outcome: "absent", completedAt: new Date() })
        .where(eq(providerAttempts.id, attempt.id));
    }
  }
  await cancelBeforeStart(db, job, "cancelled_by_user");
}

function splitChunk(data: Uint8Array): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += LOG_EVENT_MAX_BYTES) {
    pieces.push(data.subarray(offset, offset + LOG_EVENT_MAX_BYTES));
  }
  return pieces;
}

async function pullLogs(db: MetalDb, provider: GpuJobProvider, job: GpuJobRow) {
  const cursors = job.logCursors;
  const result = await provider.readLogs({
    providerResourceId: job.providerResourceId!,
    cursors: { stdout: cursors.stdout, stderr: cursors.stderr },
    complete: { stdout: cursors.stdout_eof === true, stderr: cursors.stderr_eof === true },
    waitMs: LOG_WAIT_MS,
    maxBytes: LOG_PASS_MAX_BYTES,
    signal: AbortSignal.timeout(LOG_WAIT_MS + PROVIDER_CALL_TIMEOUT_MS),
  });
  const bytes = result.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
  await withTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({
        logBytes: gpuJobs.logBytes,
        logsTruncated: gpuJobs.logsTruncated,
        logStreamOffsets: gpuJobs.logStreamOffsets,
      })
      .from(gpuJobs)
      .where(eq(gpuJobs.id, job.id))
      .for("update");
    if (!locked) return;
    const [last] = await tx
      .select({ sequence: sql<number>`coalesce(max(${gpuJobLogEvents.sequence}), 0)` })
      .from(gpuJobLogEvents)
      .where(eq(gpuJobLogEvents.gpuJobId, job.id));
    let sequence = Number(last?.sequence ?? 0);
    let logBytes = locked.logBytes;
    let truncated = locked.logsTruncated;
    const offsets: Record<string, number> = { ...locked.logStreamOffsets };
    const events: Array<typeof gpuJobLogEvents.$inferInsert> = [];
    for (const chunk of result.chunks) {
      for (const piece of splitChunk(chunk.data)) {
        if (truncated) break;
        if (logBytes + piece.byteLength > GPU_JOB_MAX_LOG_BYTES) {
          events.push({
            gpuJobId: job.id,
            sequence: ++sequence,
            type: "truncated",
            data: { limit_bytes: GPU_JOB_MAX_LOG_BYTES },
          });
          truncated = true;
          break;
        }
        const stream: ProviderGpuJobLogStream = chunk.stream;
        events.push({
          gpuJobId: job.id,
          sequence: ++sequence,
          type: stream,
          data: {
            data_base64: Buffer.from(piece).toString("base64"),
            byte_length: piece.byteLength,
            stream_offset_bytes: offsets[stream] ?? 0,
          },
        });
        offsets[stream] = (offsets[stream] ?? 0) + piece.byteLength;
        logBytes += piece.byteLength;
      }
    }
    if (events.length > 0) await tx.insert(gpuJobLogEvents).values(events);
    await tx
      .update(gpuJobs)
      .set({
        logCursors: {
          ...result.cursors,
          stdout_eof: result.complete.stdout,
          stderr_eof: result.complete.stderr,
        },
        logStreamOffsets: offsets,
        logBytes,
        logsTruncated: truncated,
      })
      .where(eq(gpuJobs.id, job.id));
  });
  return { bytes, complete: result.complete.stdout && result.complete.stderr };
}

function terminalOutcome(
  job: GpuJobRow,
  status: ProviderTerminalStatus,
): {
  state: TerminalGpuJobState;
  stateReason: string | null;
  failure: { code: string; message: string } | null;
  exitCode: number | null;
} {
  // Providers report an exit code for terminated and timed-out containers too;
  // only a command that exited on its own has a meaningful one.
  const exitCode =
    status.state === "failed" && status.reason === "exit_code_nonzero" ? status.exitCode : null;
  const runtimeFailure = {
    state: "timed_out" as const,
    stateReason: "max_runtime_exceeded",
    failure: {
      code: "max_runtime_exceeded",
      message: `job exceeded max_runtime_seconds (${job.lifecycle.max_runtime_seconds})`,
    },
    exitCode,
  };
  if (status.state === "succeeded") {
    return { state: "succeeded", stateReason: null, failure: null, exitCode: status.exitCode };
  }
  if (status.state === "failed") {
    return {
      state: "failed",
      stateReason: status.reason,
      failure: {
        code: status.reason,
        message:
          status.message ??
          (status.reason === "exit_code_nonzero"
            ? `process exited with code ${status.exitCode ?? "unknown"}`
            : `${job.provider ?? "provider"} reported ${status.reason}`),
      },
      exitCode,
    };
  }
  if (job.cancelReason === "start_deadline_exceeded") {
    return {
      state: "failed",
      stateReason: "start_deadline_exceeded",
      failure: {
        code: "start_deadline_exceeded",
        message: `no ${job.gpu.count} x ${job.gpu.type} capacity started within max_start_seconds (${job.lifecycle.max_start_seconds ?? GPU_JOB_DEFAULT_MAX_START_SECONDS})`,
      },
      exitCode: null,
    };
  }
  if (status.state === "timed_out") return runtimeFailure;
  if (job.cancelReason === "max_runtime_exceeded") return runtimeFailure;
  if (job.cancelReason) {
    return { state: "cancelled", stateReason: job.cancelReason, failure: null, exitCode };
  }
  return {
    state: "failed",
    stateReason: status.state === "absent" ? "provider_lost" : "provider_terminated",
    failure: {
      code: status.state === "absent" ? "provider_lost" : "provider_terminated",
      message:
        status.state === "absent"
          ? `${job.provider ?? "provider"} no longer has this job`
          : `${job.provider ?? "provider"} terminated the job before it completed`,
    },
    exitCode,
  };
}

async function finalizeGpuJob(
  db: MetalDb,
  provider: GpuJobProvider,
  gpuJobId: string,
  status: ProviderTerminalStatus,
): Promise<{ logsComplete: boolean }> {
  let logsComplete = false;
  for (let pass = 0; pass < LOG_DRAIN_PASSES; pass += 1) {
    const current = await loadGpuJob(db, gpuJobId);
    if (!current || current.logsComplete) {
      logsComplete = true;
      break;
    }
    const pulled = await pullLogs(db, provider, current).catch(() => ({ complete: false }));
    if (pulled.complete) {
      logsComplete = true;
      break;
    }
  }
  const job = await loadGpuJob(db, gpuJobId);
  if (!job || isTerminal(job.state)) return { logsComplete: true };
  const outcome = terminalOutcome(job, status);
  // Short jobs can start and exit between two monitor passes.
  const discoveredStart =
    !job.startedAt && job.providerResourceId && provider.startedAt
      ? await provider
          .startedAt({
            providerResourceId: job.providerResourceId,
            metalGpuJobId: job.publicId,
            signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
          })
          .catch(() => null)
      : null;
  let finished: GpuJobRow | undefined;
  await withTransaction(db, async (tx) => {
    const now = new Date();
    [finished] = await tx
      .update(gpuJobs)
      .set({
        ...(discoveredStart ? { startedAt: discoveredStart } : {}),
        state: outcome.state,
        stateReason: outcome.stateReason,
        failureCode: outcome.failure?.code ?? null,
        failureMessage: outcome.failure?.message ?? null,
        exitCode: outcome.exitCode,
        // An incomplete drain is finished by the monitor instead of dropping the tail.
        logsComplete,
        finishedAt: now,
      })
      .where(
        and(
          eq(gpuJobs.id, job.id),
          inArray(gpuJobs.state, ["provisioning", "running", "cancelling"]),
        ),
      )
      .returning();
    if (!finished) return;
    await purgeSecrets(tx, job.id);
    await completeOpenOperations(tx, job.id, "succeeded");
    if (discoveredStart) {
      await recordGpuJobEvent(tx, finished, "gpu_job.started", {
        provider: finished.provider,
        gpu_type: job.gpu.type,
        gpu_count: job.gpu.count,
      });
    }
    await recordGpuJobEvent(tx, finished, TERMINAL_EVENTS[outcome.state], {
      provider: job.provider,
      exit_code: outcome.exitCode,
      reason: outcome.stateReason,
    });
    for (const delay of FINAL_COST_DELAYS_MS) {
      await scheduleCostSync(tx, job.id, new Date(now.getTime() + delay), true);
    }
  });
  if (finished) {
    await syncGpuJobCost(db, provider, finished, false).catch(() => undefined);
  }
  return { logsComplete };
}

/** Keeps draining a finished job's logs until the provider reports the end of both streams. */
async function drainTerminalLogs(
  db: MetalDb,
  provider: GpuJobProvider,
  job: GpuJobRow,
  monitorIntervalMs: number,
): Promise<GpuJobHandlerResult> {
  const pulled = await pullLogs(db, provider, job).catch(() => ({ bytes: 0, complete: false }));
  const expired = !job.finishedAt || Date.now() - job.finishedAt.getTime() >= TERMINAL_LOG_DRAIN_MS;
  if (pulled.complete || expired) {
    await db.update(gpuJobs).set({ logsComplete: true }).where(eq(gpuJobs.id, job.id));
    return;
  }
  return { rescheduleAt: new Date(Date.now() + monitorIntervalMs) };
}

function isTerminalStatus(status: ProviderGpuJobStatus): status is ProviderTerminalStatus {
  return status.state !== "running" && status.state !== "pending";
}

export async function monitorGpuJob(
  db: MetalDb,
  providers: GpuJobProviders,
  gpuJobId: string,
  options: GpuJobWorkerOptions,
): Promise<GpuJobHandlerResult> {
  const job = await loadGpuJob(db, gpuJobId);
  if (!job?.providerResourceId) return;
  if (isTerminal(job.state)) {
    if (job.logsComplete) return;
    const provider = await resolveGpuJobProvider(db, providers, job);
    return drainTerminalLogs(db, provider, job, options.monitorIntervalMs);
  }
  if (job.state !== "provisioning" && job.state !== "running" && job.state !== "cancelling") {
    return;
  }
  const provider = await resolveGpuJobProvider(db, providers, job);
  // A log read failure must not stop status checks; the final drain retries.
  const pulled = await pullLogs(db, provider, job).catch((error: unknown) => {
    options.onLogError?.(error);
    return { bytes: 0, complete: false };
  });
  const status = await provider.status(
    job.providerResourceId,
    AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  );
  if (isTerminalStatus(status)) {
    const { logsComplete } = await finalizeGpuJob(db, provider, job.id, status);
    return logsComplete
      ? undefined
      : { rescheduleAt: new Date(Date.now() + options.monitorIntervalMs) };
  }
  if (status.state === "running" && !job.startedAt) {
    await markGpuJobStarted(db, job);
  }
  const current = (await loadGpuJob(db, gpuJobId)) ?? job;
  const now = Date.now();
  if (status.state === "pending") {
    if (current.state === "provisioning" && now >= startDeadline(current).getTime()) {
      await withTransaction(db, (tx) =>
        requestSystemCancel(tx, current, "start_deadline_exceeded"),
      );
    }
    return { rescheduleAt: new Date(now + options.monitorIntervalMs) };
  }
  if (
    current.state === "running" &&
    current.deadlineAt &&
    now >= current.deadlineAt.getTime() + DEADLINE_GRACE_MS
  ) {
    await withTransaction(db, (tx) => requestSystemCancel(tx, current, "max_runtime_exceeded"));
  }
  // The elapsed-time cost is current on every pass, so the cost limit does not
  // wait for the provider's lagging meter or the next cost sync.
  const elapsed = elapsedCostMicrousd(current, new Date(now));
  if (
    current.state === "running" &&
    current.maxCostMicrousd !== null &&
    elapsed !== null &&
    elapsed >= current.maxCostMicrousd
  ) {
    await withTransaction(db, (tx) => requestSystemCancel(tx, current, "max_cost_reached"));
  }
  if (
    !current.providerCostUpdatedAt ||
    now - current.providerCostUpdatedAt.getTime() >= COST_SYNC_INTERVAL_MS
  ) {
    // Interim cost failures must not stall log and status monitoring; the
    // final cost sync after completion retries until it succeeds.
    await syncGpuJobCost(db, provider, current, false).catch((error: unknown) => {
      options.onCostError?.(error);
    });
  }
  return {
    rescheduleAt: new Date(
      Date.now() + (pulled.bytes >= LOG_PASS_MAX_BYTES ? 250 : options.monitorIntervalMs),
    ),
  };
}

export async function cancelGpuJob(
  db: MetalDb,
  providers: GpuJobProviders,
  input: { gpuJobId: string; operationId?: string; reason: GpuJobCancelReason },
): Promise<GpuJobHandlerResult> {
  const job = await loadGpuJob(db, input.gpuJobId);
  if (!job) return;
  if (isTerminal(job.state)) {
    await setOperationState(db, input.operationId, "succeeded");
    return;
  }
  if (
    input.reason === "max_runtime_exceeded" &&
    !job.cancelReason &&
    (!job.deadlineAt || Date.now() < job.deadlineAt.getTime())
  ) {
    return;
  }
  const reason = (job.cancelReason as GpuJobCancelReason | null) ?? input.reason;
  if (!job.providerResourceId) {
    if (job.state === "provision_unknown" || job.state === "provisioning") {
      // Submit is still reconciling; the next submit attempt observes cancelling.
      await db
        .update(gpuJobs)
        .set({
          state: "cancelling",
          cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
          cancelReason: reason,
        })
        .where(eq(gpuJobs.id, job.id));
      throw new ProviderError("GPU job submit has not settled yet", "unavailable", true);
    }
    // An uncertain submit may have created the job; find it before settling.
    const [uncertain] = await db
      .select({ operationId: providerAttempts.operationId })
      .from(providerAttempts)
      .where(and(eq(providerAttempts.gpuJobId, job.id), eq(providerAttempts.state, "reconciling")))
      .limit(1);
    if (uncertain) {
      await settleCancelledSubmit(db, providers, job, uncertain.operationId);
      // A found job was adopted as cancelling; terminate it in this same pass.
      return cancelGpuJob(db, providers, input);
    }
    await cancelBeforeStart(db, job, reason);
    return;
  }
  if (job.state !== "cancelling" || !job.cancelReason) {
    await db
      .update(gpuJobs)
      .set({
        state: "cancelling",
        cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
        cancelReason: reason,
      })
      .where(
        and(
          eq(gpuJobs.id, job.id),
          inArray(gpuJobs.state, ["provisioning", "running", "cancelling"]),
        ),
      );
  }
  const provider = await resolveGpuJobProvider(db, providers, job);
  await provider.cancel(job.providerResourceId, AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS));
  const status = await provider.status(
    job.providerResourceId,
    AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  );
  if (isTerminalStatus(status)) {
    const { logsComplete } = await finalizeGpuJob(db, provider, job.id, status);
    if (!logsComplete) await scheduleMonitor(db, job.id, new Date(Date.now() + 2_000));
  } else {
    await scheduleMonitor(db, job.id, new Date(Date.now() + 2_000));
  }
}

/**
 * Cost of the time the container has run at the job's reserved size and
 * region multiplier. GPU time, most of the bill, is priced exactly; CPU and
 * memory beyond the reservation only show up in the provider's meter.
 */
export function elapsedCostMicrousd(
  job: Pick<GpuJobRow, "startedAt" | "estimatedHourlyMicrousd">,
  through: Date,
): bigint | null {
  if (!job.startedAt || job.estimatedHourlyMicrousd <= 0n) return null;
  const elapsedMs = BigInt(Math.max(0, through.getTime() - job.startedAt.getTime()));
  return (job.estimatedHourlyMicrousd * elapsedMs + 1_800_000n) / 3_600_000n;
}

function elapsedCost(
  job: GpuJobRow,
  provider: GpuJobProvider,
  metered: ProviderSandboxCost | null,
  through: Date,
): ProviderSandboxCost | null {
  const amountMicrousd = elapsedCostMicrousd(job, through);
  if (amountMicrousd === null) return null;
  return {
    amountMicrousd,
    providerOrganizationId:
      metered?.providerOrganizationId ?? job.providerOrganizationId ?? provider.name,
    measuredThrough: through,
    provenance: "estimated_rate_card",
    confidence: "medium",
    source: "metal-gpu-job-elapsed-time",
    rateCardVersion: job.rateCardVersion ?? undefined,
    raw: {
      startedAt: job.startedAt?.toISOString(),
      through: through.toISOString(),
      estimatedHourlyMicrousd: job.estimatedHourlyMicrousd.toString(),
      meteredMicrousd: metered?.amountMicrousd.toString() ?? null,
    },
  };
}

function isLastSettlement(job: GpuJobRow, final: boolean, now: Date): boolean {
  return (
    final &&
    job.finishedAt !== null &&
    now.getTime() - job.finishedAt.getTime() >= FINAL_COST_DELAYS_MS.at(-1)!
  );
}

export async function syncGpuJobCost(
  db: MetalDb,
  provider: GpuJobProvider,
  job: GpuJobRow,
  final: boolean,
) {
  if (!job.providerResourceId) return;
  const measuredAt = new Date();
  const measuredThrough = job.finishedAt ?? measuredAt;
  // The last settlement trusts the provider's meter alone; before it, the
  // elapsed-time estimate covers the lag in the provider's usage reporting.
  const settling = isLastSettlement(job, final, measuredAt);
  let metered: ProviderSandboxCost | null;
  try {
    metered = await provider.getCost({
      providerResourceId: job.providerResourceId,
      providerOrganizationId: job.providerOrganizationId ?? undefined,
      providerMetadata: job.providerMetadata,
      gpu: { type: job.gpu.type as GpuType, count: job.gpu.count },
      priceMultiplierBps: job.priceMultiplierBps,
      from: job.startedAt ?? job.submittedAt ?? job.createdAt,
      to: measuredThrough,
      signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    if (settling || elapsedCostMicrousd(job, measuredThrough) === null) throw error;
    metered = null;
  }
  const estimated = settling ? null : elapsedCost(job, provider, metered, measuredThrough);
  const cost =
    estimated && (!metered || estimated.amountMicrousd > metered.amountMicrousd)
      ? estimated
      : metered;
  if (!cost) {
    if (final && job.billingMode === "managed") {
      throw new Error("final provider cost is not available yet");
    }
    return;
  }
  await withTransaction(db, async (tx) => {
    const [locked] = await tx.select().from(gpuJobs).where(eq(gpuJobs.id, job.id)).for("update");
    if (!locked) return;
    if (cost.amountMicrousd === (locked.providerCostMicrousd ?? 0n)) {
      // Nothing new to bill; skip the snapshot so usage activity has no empty rows.
      await tx
        .update(gpuJobs)
        .set({
          providerCostMicrousd: cost.amountMicrousd,
          providerOrganizationId: cost.providerOrganizationId,
          providerCostUpdatedAt: measuredAt,
        })
        .where(eq(gpuJobs.id, job.id));
      return;
    }
    await tx
      .insert(providerCostSnapshots)
      .values({
        gpuJobId: job.id,
        organizationId: job.organizationId,
        projectId: job.projectId,
        provider: provider.name,
        providerResourceId: job.providerResourceId!,
        billingMode: job.billingMode,
        amountMicrousd: cost.amountMicrousd,
        costDeltaMicrousd: cost.amountMicrousd - (locked.providerCostMicrousd ?? 0n),
        measuredFrom: locked.providerCostMeasuredThrough,
        measuredThrough: cost.measuredThrough,
        costProvenance: cost.provenance,
        costConfidence: cost.confidence,
        costSource: cost.source,
        rateCardVersion: cost.rateCardVersion,
        rawPayload: cost.raw,
      })
      .onConflictDoNothing();
    const snapshot = await tx
      .select()
      .from(providerCostSnapshots)
      .where(
        and(
          eq(providerCostSnapshots.gpuJobId, job.id),
          eq(providerCostSnapshots.amountMicrousd, cost.amountMicrousd),
          eq(providerCostSnapshots.measuredThrough, cost.measuredThrough),
        ),
      )
      .then((rows) => rows[0]);
    const [updated] = await tx
      .update(gpuJobs)
      .set({
        providerCostMicrousd: cost.amountMicrousd,
        providerOrganizationId: cost.providerOrganizationId,
        providerCostMeasuredThrough: cost.measuredThrough,
        providerCostUpdatedAt: measuredAt,
      })
      .where(eq(gpuJobs.id, job.id))
      .returning();
    if (!updated) return;
    if (cost.amountMicrousd !== locked.providerCostMicrousd) {
      await recordGpuJobEvent(tx, updated, "gpu_job.cost_updated", {
        provider: provider.name,
        cost_microusd: cost.amountMicrousd.toString(),
        cost_updated_at: measuredAt.toISOString(),
      });
    }
    if (snapshot && job.billingMode === "managed") {
      await chargeUsageDelta(tx, {
        organizationId: job.organizationId,
        projectId: job.projectId,
        gpuJobId: job.id,
        snapshotId: snapshot.id,
        currentCostMicrousd: cost.amountMicrousd,
        measuredFrom: locked.providerCostMeasuredThrough,
        measuredThrough: cost.measuredThrough,
        actorId: job.createdBy,
      });
    }
    if (
      updated.maxCostMicrousd !== null &&
      cost.amountMicrousd >= updated.maxCostMicrousd &&
      updated.state === "running"
    ) {
      await requestSystemCancel(tx, updated, "max_cost_reached");
    }
  });
}

export async function syncGpuJobCostJob(
  db: MetalDb,
  providers: GpuJobProviders,
  gpuJobId: string,
  final: boolean,
) {
  const job = await loadGpuJob(db, gpuJobId);
  if (!job?.providerResourceId) return;
  const provider = await resolveGpuJobProvider(db, providers, job);
  await syncGpuJobCost(db, provider, job, final);
}

/** Marks a GPU job failed when its submit job has exhausted its retries. */
export async function recordTerminalGpuJobSubmitFailure(
  db: MetalDb,
  gpuJobId: string,
  operationId: string,
  error: unknown,
) {
  const job = await loadGpuJob(db, gpuJobId);
  if (!job || job.providerResourceId || isTerminal(job.state)) return;
  if (job.state === "cancelling") {
    await cancelBeforeStart(db, job, "cancelled_by_user");
    return;
  }
  await failBeforeStart(db, job, operationId, {
    code: "submit_failed",
    message: safeError(error),
  });
}

export async function gpuJobSubmitIsReconciling(db: MetalDb, gpuJobId: string) {
  const job = await loadGpuJob(db, gpuJobId);
  return job?.state === "provision_unknown";
}

/** Recovers GPU job work whose outbox jobs were lost or exhausted their retries. */
export async function scheduleMissingGpuJobWork(db: MetalDb, now = new Date()) {
  const unmonitored = await db
    .select({ id: gpuJobs.id })
    .from(gpuJobs)
    .where(
      and(
        or(
          inArray(gpuJobs.state, ["provisioning", "running", "cancelling"]),
          and(
            eq(gpuJobs.logsComplete, false),
            gte(gpuJobs.finishedAt, new Date(now.getTime() - TERMINAL_LOG_DRAIN_MS)),
          ),
        ),
        isNotNull(gpuJobs.providerResourceId),
        notExists(
          db
            .select({ id: outboxJobs.id })
            .from(outboxJobs)
            .where(
              and(
                eq(outboxJobs.dedupeKey, sql`'gpu_job:monitor:' || ${gpuJobs.id}::text`),
                inArray(outboxJobs.status, ["pending", "leased"]),
              ),
            ),
        ),
      ),
    )
    .limit(100);
  for (const job of unmonitored) {
    await scheduleMonitor(db, job.id, now);
  }
  const staleCancels = await db
    .select({ id: gpuJobs.id, cancelReason: gpuJobs.cancelReason })
    .from(gpuJobs)
    .where(
      and(
        eq(gpuJobs.state, "cancelling"),
        lt(gpuJobs.cancelRequestedAt, new Date(now.getTime() - STALE_CANCEL_MS)),
        notExists(
          db
            .select({ id: outboxJobs.id })
            .from(outboxJobs)
            .where(
              and(
                eq(outboxJobs.dedupeKey, sql`'gpu_job:cancel:' || ${gpuJobs.id}::text`),
                inArray(outboxJobs.status, ["pending", "leased"]),
              ),
            ),
        ),
      ),
    )
    .limit(100);
  for (const job of staleCancels) {
    await enqueueCancel(
      db,
      job.id,
      (job.cancelReason as GpuJobCancelReason | null) ?? "cancelled_by_user",
    );
  }
}

const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// Providers publish billing with a delay, so a day is reconciled this long after it ends.
const RECONCILE_DELAY_MS = 6 * 60 * 60_000;

/** Enqueues the periodic GPU sweeps. Dedupe keys keep one job per period across workers. */
export async function scheduleGpuJobMaintenance(db: MetalDb, now = new Date()) {
  const sweepBucket = Math.floor(now.getTime() / ORPHAN_SWEEP_INTERVAL_MS);
  const reconcileEnd = new Date(Math.floor((now.getTime() - RECONCILE_DELAY_MS) / DAY_MS) * DAY_MS);
  const reconcileStart = new Date(reconcileEnd.getTime() - DAY_MS);
  await db
    .insert(outboxJobs)
    .values([
      {
        jobType: "gpu_job.orphan_sweep",
        dedupeKey: `gpu_job:orphan_sweep:${sweepBucket}`,
        payload: { job_type: "gpu_job.orphan_sweep" },
      },
      {
        jobType: "gpu_job.cost_reconcile",
        dedupeKey: `gpu_job:cost_reconcile:${reconcileStart.toISOString().slice(0, 10)}`,
        payload: {
          job_type: "gpu_job.cost_reconcile",
          window_start: reconcileStart.toISOString(),
          window_end: reconcileEnd.toISOString(),
        },
      },
    ])
    .onConflictDoNothing();
}

/**
 * Terminates provider resources in Metal's own provider accounts that no live
 * job owns: duplicates from uncertain submits, jobs that finished without the
 * container stopping, and jobs whose rows were deleted.
 */
export async function sweepOrphanedGpuJobs(
  db: MetalDb,
  providers: GpuJobProviders,
  input: { environment: string; now?: Date },
): Promise<{ terminated: string[] }> {
  const now = input.now ?? new Date();
  const terminated: string[] = [];
  for (const provider of Object.values(providers)) {
    if (!provider?.listActiveJobs) continue;
    const listings = (await provider.listActiveJobs(AbortSignal.timeout(ORPHAN_SWEEP_TIMEOUT_MS)))
      // Another deployment sharing the provider account owns its own resources.
      .filter((listing) => listing.metalGpuJobId && listing.metalEnvironment === input.environment)
      .filter((listing) => now.getTime() - listing.createdAt.getTime() >= ORPHAN_MIN_AGE_MS);
    if (listings.length === 0) continue;
    const rows = await db
      .select({
        publicId: gpuJobs.publicId,
        state: gpuJobs.state,
        providerResourceId: gpuJobs.providerResourceId,
        providerCredentialId: gpuJobs.providerCredentialId,
      })
      .from(gpuJobs)
      .where(
        inArray(
          gpuJobs.publicId,
          listings.map((listing) => listing.metalGpuJobId!),
        ),
      );
    const byId = new Map(rows.map((row) => [row.publicId, row]));
    for (const listing of listings) {
      const job = byId.get(listing.metalGpuJobId!);
      const orphaned =
        !job ||
        isTerminal(job.state) ||
        (job.providerResourceId !== null && job.providerResourceId !== listing.providerResourceId);
      if (!orphaned || job?.providerCredentialId) continue;
      await provider.cancel(
        listing.providerResourceId,
        AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
      );
      terminated.push(listing.providerResourceId);
    }
  }
  return { terminated };
}

export type GpuCostReconciliation = {
  provider: GpuJobProviderName;
  scope: string;
  reportedMicrousd: bigint;
  meteredMicrousd: bigint;
  driftMicrousd: bigint;
};

/**
 * Compares what Metal metered for managed jobs in a window with what the
 * provider bills for them. Drift means the rate card or usage parsing is off.
 */
export async function reconcileGpuJobCosts(
  db: MetalDb,
  providers: GpuJobProviders,
  window: { start: Date; end: Date },
): Promise<GpuCostReconciliation[]> {
  const results: GpuCostReconciliation[] = [];
  for (const provider of Object.values(providers)) {
    if (!provider?.reportedCost) continue;
    const reported = await provider.reportedCost({
      from: window.start,
      to: window.end,
      signal: AbortSignal.timeout(ORPHAN_SWEEP_TIMEOUT_MS),
    });
    const [metered] = await db
      .select({
        amount: sql<string>`coalesce(sum(${providerCostSnapshots.costDeltaMicrousd}), 0)::text`,
      })
      .from(providerCostSnapshots)
      .where(
        and(
          isNotNull(providerCostSnapshots.gpuJobId),
          eq(providerCostSnapshots.provider, provider.name),
          eq(providerCostSnapshots.billingMode, "managed"),
          gte(providerCostSnapshots.measuredThrough, window.start),
          lt(providerCostSnapshots.measuredThrough, window.end),
        ),
      );
    const meteredMicrousd = BigInt(metered?.amount ?? "0");
    const driftMicrousd = reported.amountMicrousd - meteredMicrousd;
    await db
      .insert(gpuCostReconciliations)
      .values({
        provider: provider.name,
        providerScope: reported.scope,
        windowStart: window.start,
        windowEnd: window.end,
        providerReportedMicrousd: reported.amountMicrousd,
        metalMeteredMicrousd: meteredMicrousd,
        driftMicrousd,
        rawPayload: reported.raw,
      })
      .onConflictDoUpdate({
        target: [
          gpuCostReconciliations.provider,
          gpuCostReconciliations.providerScope,
          gpuCostReconciliations.windowStart,
          gpuCostReconciliations.windowEnd,
        ],
        set: {
          providerReportedMicrousd: reported.amountMicrousd,
          metalMeteredMicrousd: meteredMicrousd,
          driftMicrousd,
          rawPayload: reported.raw,
          createdAt: new Date(),
        },
      });
    results.push({
      provider: provider.name,
      scope: reported.scope,
      reportedMicrousd: reported.amountMicrousd,
      meteredMicrousd,
      driftMicrousd,
    });
  }
  return results;
}

/** Drift worth an alert: over 2% of the provider's figure and over $0.50. */
export function isSignificantCostDrift(result: GpuCostReconciliation): boolean {
  const drift = result.driftMicrousd < 0n ? -result.driftMicrousd : result.driftMicrousd;
  return drift > 500_000n && drift * 50n > result.reportedMicrousd;
}

export async function cleanupExpiredGpuJobLogs(db: MetalDb, retentionMs: number) {
  await db.execute(sql`
    delete from metal.gpu_job_log_events
    where id in (
      select events.id
      from metal.gpu_job_log_events events
      inner join metal.gpu_jobs jobs on jobs.id = events.gpu_job_id
      where jobs.finished_at < ${new Date(Date.now() - retentionMs).toISOString()}::timestamptz
      limit 1000
    )
  `);
}
