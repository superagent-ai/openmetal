import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  gpuJobLogEvents,
  gpuJobs,
  insertDomainEventAndBroadcast,
  operations,
  organizationProviderCredentials,
  outboxJobs,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import {
  GPU_JOB_DEFAULT_MAX_START_SECONDS,
  GpuJobSchema,
  TERMINAL_GPU_JOB_STATES,
  type GpuJob,
  type GpuTypeCatalogResponse,
  type ParsedCreateGpuJobRequest,
} from "@openmetal/contracts";
import { projectTopic } from "@openmetal/events";
import {
  GPU_OFFERS,
  GPU_REGIONS,
  GPU_TYPE_CATALOG,
  estimateGpuJobHourlyMicrousd,
  regionPriceMultiplierBps,
  type GpuOffer,
  type GpuType,
  type GpuJobProviderName,
} from "@openmetal/provider-core";
import { managedGpuFundingShortfall } from "@openmetal/billing";
import { ApiError } from "./errors.js";
import { createOperation, updateOperation } from "./operation-service.js";

type Scope = { organizationId: string; projectId: string };
type GpuJobRow = typeof gpuJobs.$inferSelect;

const MAX_LOG_EVENT_BATCH_COUNT = 200;
const MAX_LOG_EVENT_BATCH_BYTES = 1_048_576;
const MICROUSD_PER_USD = 1_000_000n;

function projectPublicId(projectId: string): string {
  return `prj_${projectId.replaceAll("-", "")}`;
}

function usdToMicrousd(value: string): bigint {
  const [dollars = "0", decimals = ""] = value.split(".");
  return BigInt(dollars) * MICROUSD_PER_USD + BigInt(decimals.padEnd(6, "0"));
}

function microusdToUsd(value: bigint): string {
  return `${value / MICROUSD_PER_USD}.${(value % MICROUSD_PER_USD).toString().padStart(6, "0")}`;
}

function nonEmpty<T extends Record<string, unknown>>(value: T | null | undefined): T | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

function multiplierString(bps: number): string {
  return `${Math.floor(bps / 10_000)}.${String(Math.round((bps % 10_000) / 100)).padStart(2, "0")}`;
}

export function gpuTypeCatalog(): GpuTypeCatalogResponse {
  return {
    gpu_types: (Object.keys(GPU_TYPE_CATALOG) as GpuType[]).map((id) => ({
      id,
      name: GPU_TYPE_CATALOG[id].name,
      vram_gb: GPU_TYPE_CATALOG[id].vramGb,
      offers: GPU_OFFERS.filter((offer) => offer.gpuType === id).map((offer) => ({
        provider: offer.provider,
        provider_gpu: offer.providerGpu,
        max_count: offer.maxCount,
        max_runtime_seconds: offer.maxRuntimeSeconds,
        price_per_gpu_hour_usd: microusdToUsd(offer.gpuMicrousdPerHour),
        cpu_price_per_core_hour_usd: microusdToUsd(offer.cpuMicrousdPerCoreHour),
        memory_price_per_gib_hour_usd: microusdToUsd(offer.memoryMicrousdPerGibHour),
        billing_granularity: "per_second" as const,
        region_price_multipliers: {
          broad: multiplierString(offer.regionMultiplierBps.broad),
          narrow: multiplierString(offer.regionMultiplierBps.narrow),
        },
        rate_card_version: offer.rateCardVersion,
      })),
    })),
    regions: GPU_REGIONS.map((region) => ({ ...region })),
  };
}

/** Credentials a job needs at submit, kept together in one Vault secret. */
export type GpuJobVaultPayload = {
  version: 2;
  environment: Record<string, string>;
  registry: Record<string, string> | null;
  mounts: Array<Record<string, string>>;
};

export function serializeGpuJob(row: GpuJobRow): GpuJob {
  const resolved = row.resolved as {
    gpuType: GpuType;
    gpuCount: number;
    providerGpu: string;
    vcpu: number | null;
    memoryMb: number | null;
  } | null;
  return GpuJobSchema.parse({
    id: row.publicId,
    type: "gpu_job",
    project_id: projectPublicId(row.projectId),
    state: row.state,
    state_reason: row.stateReason,
    failure: row.failureCode
      ? { code: row.failureCode, message: row.failureMessage ?? row.failureCode }
      : null,
    provider: row.provider,
    billing_mode: row.billingMode === "byok" ? "byok" : "managed",
    requested: {
      provider: row.primaryProvider,
      source: row.source,
      gpu: row.gpu,
      resources: nonEmpty(row.resources),
      placement: nonEmpty(row.placement),
      lifecycle: {
        max_runtime_seconds: row.lifecycle.max_runtime_seconds,
        max_start_seconds: row.lifecycle.max_start_seconds ?? GPU_JOB_DEFAULT_MAX_START_SECONDS,
      },
      limits: nonEmpty(row.limits),
      environment: nonEmpty(row.environment),
      secret_names: row.secretNames,
      mounts: row.mounts.length > 0 ? row.mounts : undefined,
      provider_options: nonEmpty(row.providerOptions),
      metadata: nonEmpty(row.metadata),
    },
    pricing: {
      price_multiplier: multiplierString(row.priceMultiplierBps),
      estimated_hourly_cost_usd: microusdToUsd(row.estimatedHourlyMicrousd),
      rate_card_version: row.rateCardVersion,
    },
    resolved: resolved
      ? {
          gpu_type: resolved.gpuType,
          gpu_count: resolved.gpuCount,
          vram_gb_per_gpu: GPU_TYPE_CATALOG[resolved.gpuType].vramGb,
          provider_gpu: resolved.providerGpu,
          vcpu: resolved.vcpu,
          memory_mb: resolved.memoryMb,
        }
      : null,
    exit_code: row.exitCode,
    cost_microusd: row.providerCostMicrousd?.toString() ?? null,
    cost_updated_at: row.providerCostUpdatedAt?.toISOString() ?? null,
    logs_complete: row.logsComplete,
    logs_truncated: row.logsTruncated,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    submitted_at: row.submittedAt?.toISOString() ?? null,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    cancel_requested_at: row.cancelRequestedAt?.toISOString() ?? null,
    metadata: nonEmpty(row.metadata),
  });
}

function candidateProviders(request: ParsedCreateGpuJobRequest): GpuJobProviderName[] {
  const offered = [
    ...new Set(
      GPU_OFFERS.filter((offer) => offer.gpuType === request.gpu.type).map(
        (offer) => offer.provider,
      ),
    ),
  ];
  const requested = request.provider ?? "auto";
  return requested === "auto" ? offered : offered.filter((provider) => provider === requested);
}

function requireSupportedRequest(request: ParsedCreateGpuJobRequest): GpuJobProviderName[] {
  const candidates = candidateProviders(request);
  if (candidates.length === 0) {
    throw new ApiError(
      422,
      "capability_unsupported",
      request.provider && request.provider !== "auto"
        ? `${request.provider} does not offer ${request.gpu.type} GPUs`
        : `no provider offers ${request.gpu.type} GPUs`,
      { gpu_type: request.gpu.type },
    );
  }
  const eligible = candidates.filter((provider) => {
    const offer = GPU_OFFERS.find(
      (candidate) => candidate.provider === provider && candidate.gpuType === request.gpu.type,
    )!;
    return (
      request.gpu.count <= offer.maxCount &&
      request.lifecycle.max_runtime_seconds <= offer.maxRuntimeSeconds
    );
  });
  if (eligible.length === 0) {
    const limits = candidates.map((provider) => {
      const offer = GPU_OFFERS.find(
        (candidate) => candidate.provider === provider && candidate.gpuType === request.gpu.type,
      )!;
      return {
        provider,
        max_count: offer.maxCount,
        max_runtime_seconds: offer.maxRuntimeSeconds,
      };
    });
    throw new ApiError(
      422,
      "capability_unsupported",
      "no provider can run the requested GPU count and runtime",
      { limits },
    );
  }
  return eligible;
}

async function activeCredentialProviders(tx: MetalDb, organizationId: string) {
  const rows = await tx
    .select({ provider: organizationProviderCredentials.provider })
    .from(organizationProviderCredentials)
    .where(
      and(
        eq(organizationProviderCredentials.organizationId, organizationId),
        isNull(organizationProviderCredentials.disabledAt),
      ),
    );
  return new Set(rows.map((row) => row.provider));
}

export async function createGpuJob(
  tx: MetalDb,
  input: Scope & { actorId: string; request: ParsedCreateGpuJobRequest },
) {
  const request = input.request;
  const candidates = requireSupportedRequest(request);
  const byokProviders = await activeCredentialProviders(tx, input.organizationId);
  const volumes = request.provider_options?.modal?.volumes ?? [];
  if (volumes.length > 0 && !byokProviders.has("modal")) {
    throw new ApiError(
      422,
      "capability_unsupported",
      "Modal volumes require your own Modal credentials; managed jobs cannot mount volumes",
    );
  }
  const managed = candidates.some((provider) => !byokProviders.has(provider));
  const offer = GPU_OFFERS.find(
    (candidate): candidate is GpuOffer =>
      candidate.provider === candidates[0] && candidate.gpuType === request.gpu.type,
  )!;
  const priceMultiplierBps = regionPriceMultiplierBps(offer, request.placement?.regions);
  const estimatedHourlyMicrousd = estimateGpuJobHourlyMicrousd(offer, {
    gpuCount: request.gpu.count,
    vcpu: request.resources?.vcpu,
    memoryMb: request.resources?.memory_mb,
    multiplierBps: priceMultiplierBps,
  });
  if (managed) {
    const shortfall = await managedGpuFundingShortfall(tx, input.organizationId, {
      hourlyMicrousd: estimatedHourlyMicrousd,
    });
    if (shortfall) {
      throw new ApiError(
        402,
        "insufficient_credits",
        `managed GPU jobs need enough credits for ${shortfall.windowSeconds / 60} minutes of this job and the organization's other running GPU jobs`,
        {
          required_usd: microusdToUsd(shortfall.requiredMicrousd),
          balance_usd: microusdToUsd(
            shortfall.balanceMicrousd > 0n ? shortfall.balanceMicrousd : 0n,
          ),
          funding_window_seconds: shortfall.windowSeconds,
        },
      );
    }
  }

  const gpuJobId = crypto.randomUUID();
  const publicId = `gpj_${gpuJobId.replaceAll("-", "")}`;
  const secretEntries = Object.entries(request.secrets ?? {});
  const { registry_auth: registryAuth, ...source } = request.source;
  const mounts = request.mounts ?? [];
  let secretsVaultId: string | null = null;
  if (secretEntries.length > 0 || registryAuth || mounts.length > 0) {
    const payload: GpuJobVaultPayload = {
      version: 2,
      environment: Object.fromEntries(secretEntries),
      registry: registryAuth ? { ...registryAuth } : null,
      mounts: mounts.map((mount) => ({ ...mount.credentials })),
    };
    const rows = (await tx.execute(sql`
      select vault.create_secret(
        ${JSON.stringify(payload)},
        ${`metal:gpu-job:${gpuJobId}`},
        ${"Metal GPU job secrets"}
      ) as id
    `)) as unknown as Array<{ id: string }>;
    secretsVaultId = rows[0]?.id ?? null;
    if (!secretsVaultId) {
      throw new ApiError(500, "internal_error", "failed to encrypt GPU job secrets");
    }
  }

  const [job] = await tx
    .insert(gpuJobs)
    .values({
      id: gpuJobId,
      publicId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      createdBy: input.actorId,
      primaryProvider: request.provider ?? "auto",
      state: "requested",
      source: registryAuth ? { ...source, registry_auth: { kind: registryAuth.kind } } : source,
      gpu: request.gpu,
      resources: request.resources ?? {},
      placement: request.placement ?? {},
      lifecycle: request.lifecycle,
      limits: request.limits ?? {},
      mounts: mounts.map(({ credentials: _credentials, ...mount }) => mount),
      priceMultiplierBps,
      estimatedHourlyMicrousd,
      rateCardVersion: offer.rateCardVersion,
      maxCostMicrousd: request.limits?.max_cost_usd
        ? usdToMicrousd(request.limits.max_cost_usd)
        : null,
      environment: request.environment ?? {},
      secretNames: secretEntries.map(([name]) => name).sort(),
      secretsVaultId,
      providerOptions: request.provider_options ?? {},
      metadata: request.metadata ?? {},
    })
    .returning();
  if (!job) {
    throw new ApiError(500, "internal_error", "failed to create GPU job");
  }
  await insertDomainEventAndBroadcast(tx, {
    type: "gpu_job.requested",
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    data: {
      gpu_job_id: job.publicId,
      provider: job.primaryProvider,
      gpu_type: request.gpu.type,
      gpu_count: request.gpu.count,
    },
    topic: projectTopic(projectPublicId(input.projectId)),
  });
  const operation = await createOperation(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    gpuJobId: job.id,
    type: "gpu_job_create",
  });
  await tx.insert(outboxJobs).values({
    jobType: "gpu_job.submit",
    dedupeKey: `gpu_job:submit:${job.id}`,
    payload: { job_type: "gpu_job.submit", gpu_job_id: job.id, operation_id: operation.id },
  });
  return { gpuJob: job, operation };
}

export async function getGpuJob(db: MetalDb, input: Scope & { gpuJobId: string }) {
  const job = await db
    .select()
    .from(gpuJobs)
    .where(
      and(
        eq(gpuJobs.publicId, input.gpuJobId),
        eq(gpuJobs.organizationId, input.organizationId),
        eq(gpuJobs.projectId, input.projectId),
      ),
    )
    .then((rows) => rows[0]);
  if (!job) {
    throw new ApiError(404, "not_found", "GPU job not found");
  }
  return job;
}

export async function listGpuJobs(
  db: MetalDb,
  input: Scope & { cursor?: string; limit: number; state?: string },
) {
  let after: { createdAt: Date; id: string } | undefined;
  if (input.cursor) {
    after = await db
      .select({ createdAt: gpuJobs.createdAt, id: gpuJobs.id })
      .from(gpuJobs)
      .where(and(eq(gpuJobs.publicId, input.cursor), eq(gpuJobs.projectId, input.projectId)))
      .then((rows) => rows[0]);
    if (!after) {
      throw new ApiError(422, "validation_error", "invalid GPU job cursor");
    }
  }
  const rows = await db
    .select()
    .from(gpuJobs)
    .where(
      and(
        eq(gpuJobs.organizationId, input.organizationId),
        eq(gpuJobs.projectId, input.projectId),
        input.state ? eq(gpuJobs.state, input.state) : undefined,
        after
          ? or(
              lt(gpuJobs.createdAt, after.createdAt),
              and(eq(gpuJobs.createdAt, after.createdAt), lt(gpuJobs.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(gpuJobs.createdAt), desc(gpuJobs.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return {
    rows: page,
    nextCursor: rows.length > input.limit ? (page.at(-1)?.publicId ?? null) : null,
  };
}

export async function requestGpuJobCancel(db: MetalDb, input: Scope & { gpuJobId: string }) {
  return withTransaction(db, async (tx) => {
    const found = await getGpuJob(tx, input);
    const [job] = await tx.select().from(gpuJobs).where(eq(gpuJobs.id, found.id)).for("update");
    if (!job) {
      throw new ApiError(404, "not_found", "GPU job not found");
    }
    if ((TERMINAL_GPU_JOB_STATES as readonly string[]).includes(job.state)) {
      throw new ApiError(409, "gpu_job_terminal", `GPU job is already ${job.state}`, {
        state: job.state,
      });
    }
    const operation = await createOperation(tx, {
      organizationId: job.organizationId,
      projectId: job.projectId,
      gpuJobId: job.id,
      type: "gpu_job_cancel",
    });
    const now = new Date();
    if (job.state === "requested") {
      const [cancelled] = await tx
        .update(gpuJobs)
        .set({
          state: "cancelled",
          stateReason: "cancelled_by_user",
          cancelRequestedAt: now,
          cancelReason: "cancelled_by_user",
          logsComplete: true,
          finishedAt: now,
        })
        .where(eq(gpuJobs.id, job.id))
        .returning();
      await tx.execute(sql`select metal.purge_gpu_job_secrets(${job.id})`);
      const open = await tx
        .select({ id: operations.id, type: operations.type })
        .from(operations)
        .where(
          and(
            eq(operations.gpuJobId, job.id),
            inArray(operations.state, ["queued", "running", "reconciling"]),
          ),
        );
      for (const pending of open) {
        await updateOperation(tx, pending.id, {
          state: pending.type === "gpu_job_create" ? "cancelled" : "succeeded",
        });
      }
      await insertDomainEventAndBroadcast(tx, {
        type: "gpu_job.cancelled",
        organizationId: job.organizationId,
        projectId: job.projectId,
        actorId: job.createdBy,
        data: { gpu_job_id: job.publicId, reason: "cancelled_by_user" },
        topic: projectTopic(projectPublicId(job.projectId)),
      });
      return {
        gpuJob: cancelled ?? job,
        operation: { ...operation, state: "succeeded", completedAt: now },
      };
    }
    const [cancelling] = await tx
      .update(gpuJobs)
      .set({
        state: "cancelling",
        cancelRequestedAt: job.cancelRequestedAt ?? now,
        cancelReason: job.cancelReason ?? "cancelled_by_user",
      })
      .where(eq(gpuJobs.id, job.id))
      .returning();
    const payload = {
      job_type: "gpu_job.cancel",
      gpu_job_id: job.id,
      operation_id: operation.id,
      reason: job.cancelReason ?? "cancelled_by_user",
    };
    await tx
      .insert(outboxJobs)
      .values({ jobType: "gpu_job.cancel", dedupeKey: `gpu_job:cancel:${job.id}`, payload })
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
    return { gpuJob: cancelling ?? job, operation };
  });
}

export async function listGpuJobLogEvents(
  db: MetalDb,
  input: Scope & { gpuJobId: string; after: number },
) {
  const job = await getGpuJob(db, input);
  const events = await db
    .select()
    .from(gpuJobLogEvents)
    .where(and(eq(gpuJobLogEvents.gpuJobId, job.id), gt(gpuJobLogEvents.sequence, input.after)))
    .orderBy(asc(gpuJobLogEvents.sequence))
    .limit(MAX_LOG_EVENT_BATCH_COUNT);
  const bounded: Array<{
    sequence: number;
    gpu_job_id: string;
    type: string;
    occurred_at: string;
    data: Record<string, unknown>;
  }> = [];
  let totalBytes = 0;
  for (const event of events) {
    const publicEvent = {
      sequence: event.sequence,
      gpu_job_id: job.publicId,
      type: event.type,
      occurred_at: event.occurredAt.toISOString(),
      data: event.data,
    };
    const eventBytes = Buffer.byteLength(
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(publicEvent)}\n\n`,
      "utf8",
    );
    if (bounded.length > 0 && totalBytes + eventBytes > MAX_LOG_EVENT_BATCH_BYTES) break;
    bounded.push(publicEvent);
    totalBytes += eventBytes;
  }
  return { job, events: bounded };
}
