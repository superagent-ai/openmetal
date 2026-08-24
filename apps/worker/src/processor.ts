import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  claimOutboxJobs,
  domainEvents,
  operationEvents,
  operations,
  outboxJobs,
  providerAttempts,
  providerCostSnapshots,
  sandboxes,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import {
  OutboxJobPayloadSchema,
  projectTopic,
  publicationDedupeKey,
  serializeCursor,
  toPublicEvent,
  type OutboxJobPayload,
} from "@openmetal/events";
import { createLogger, redactString } from "@openmetal/logger";
import {
  ProviderError,
  resolveMetalEnvironment,
  resolveProviderResources,
  type ProviderCreateSandboxInput,
  type SandboxProvider,
  type SandboxProviderName,
} from "@openmetal/provider-core";
import type { WorkerEnv } from "./env.js";
import type { BroadcastPublisher } from "./publisher.js";

type SandboxProviders = Partial<Record<SandboxProviderName, SandboxProvider>>;

function backoffMs(attempt: number, base: number): number {
  const exp = Math.min(base * 2 ** Math.max(attempt - 1, 0), 30_000);
  return Math.round(exp * (0.5 + Math.random()));
}

function northflankBillingAvailableAt(measuredThrough: Date): Date {
  const hourMs = 60 * 60_000;
  const nextHour = (Math.floor(measuredThrough.getTime() / hourMs) + 1) * hourMs;
  return new Date(nextHour + 10 * 60_000);
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return redactString(error.message.slice(0, 500));
  }
  return "unknown error";
}

async function appendOperationEvent(
  db: MetalDb,
  operationId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  const rows = await db
    .select({ sequence: operationEvents.sequence })
    .from(operationEvents)
    .where(eq(operationEvents.operationId, operationId));
  await db.insert(operationEvents).values({
    operationId,
    sequence: rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1,
    type,
    data,
  });
}

async function setOperationState(
  db: MetalDb,
  operationId: string | undefined,
  state: string,
  error?: Record<string, unknown> | null,
) {
  if (!operationId) return;
  const now = new Date();
  const terminal = ["succeeded", "failed", "cancelled"].includes(state);
  await db
    .update(operations)
    .set({
      state,
      error,
      retryable: Boolean(error?.retryable),
      updatedAt: now,
      completedAt: terminal ? now : null,
    })
    .where(eq(operations.id, operationId));
  await appendOperationEvent(db, operationId, terminal ? "completed" : "state_changed", { state });
}

function classifyProviderFailure(error: unknown): {
  kind: string;
  retryable: boolean;
  fallbackSafe: boolean;
  unknown: boolean;
} {
  if (error instanceof ProviderError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      fallbackSafe: ["capacity", "unavailable", "timeout_absent"].includes(error.kind),
      unknown: error.kind === "unknown_outcome",
    };
  }
  const message = safeError(error).toLowerCase();
  if (/401|403|auth/.test(message)) {
    return { kind: "provider_auth_error", retryable: false, fallbackSafe: false, unknown: false };
  }
  if (/429|capacity|quota/.test(message)) {
    return {
      kind: "provider_capacity_unavailable",
      retryable: true,
      fallbackSafe: true,
      unknown: false,
    };
  }
  if (/timeout|abort/.test(message)) {
    return {
      kind: "provider_unknown_outcome",
      retryable: true,
      fallbackSafe: false,
      unknown: true,
    };
  }
  if (/500|502|503|unavailable/.test(message)) {
    return { kind: "provider_unavailable", retryable: true, fallbackSafe: true, unknown: false };
  }
  return { kind: "provider_error", retryable: false, fallbackSafe: false, unknown: false };
}

async function scheduleCostSync(tx: MetalDb, sandboxId: string, availableAt: Date, final: boolean) {
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "sandbox.cost.sync",
      dedupeKey: `sandbox:cost:${sandboxId}:${availableAt.getTime()}:${final}`,
      payload: {
        job_type: "sandbox.cost.sync",
        sandbox_id: sandboxId,
        final,
      },
      availableAt,
    })
    .onConflictDoNothing();
}

async function recordSandboxEvent(
  tx: MetalDb,
  sandbox: typeof sandboxes.$inferSelect,
  type:
    | "sandbox.ready"
    | "sandbox.paused"
    | "sandbox.resumed"
    | "sandbox.cost_updated"
    | "sandbox.failed"
    | "sandbox.deleted",
  data: Record<string, unknown>,
) {
  const [event] = await tx
    .insert(domainEvents)
    .values({
      type,
      organizationId: sandbox.organizationId,
      projectId: sandbox.projectId,
      actorId: sandbox.createdBy,
      payload: { sandbox_id: sandbox.id, ...data },
      occurredAt: new Date(),
    })
    .returning();
  if (!event) {
    throw new Error("failed to persist sandbox event");
  }
  const publicEvent = toPublicEvent({
    cursor: serializeCursor(event.cursor),
    eventId: event.eventId,
    type: event.type,
    organizationId: event.organizationId,
    projectId: event.projectId ? `prj_${event.projectId.replaceAll("-", "")}` : undefined,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
  await tx.insert(outboxJobs).values({
    jobType: "realtime.broadcast",
    dedupeKey: publicationDedupeKey(event.eventId),
    payload: {
      job_type: "realtime.broadcast",
      topic: projectTopic(`prj_${sandbox.projectId.replaceAll("-", "")}`),
      event: publicEvent,
    },
  });
}

async function provisionSandbox(
  db: MetalDb,
  providers: SandboxProviders,
  sandboxId: string,
  operationId: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (
    !sandbox ||
    sandbox.status === "ready" ||
    sandbox.status === "stopping" ||
    sandbox.status === "stopped"
  ) {
    return;
  }
  await setOperationState(db, operationId, "running");
  const fallback = sandbox.fallback as { providers?: SandboxProviderName[]; max_attempts?: number };
  const configuredProviders = Object.keys(providers) as SandboxProviderName[];
  const fallbackProviders = fallback.providers ?? [];
  const candidates = (
    sandbox.primaryProvider === "auto"
      ? [
          ...fallbackProviders,
          ...configuredProviders.filter((provider) => !fallbackProviders.includes(provider)),
        ]
      : [sandbox.primaryProvider as SandboxProviderName, ...fallbackProviders]
  ).slice(0, fallback.max_attempts ?? 9);
  const source = sandbox.source as ProviderCreateSandboxInput["source"];
  const environmentSource = resolveMetalEnvironment(source);
  const requested = sandbox.resourceRequirements as {
    vcpu: number;
    memory_mb: number;
    disk_mb?: number;
    architecture?: "x86_64" | "arm64" | "any";
  };
  const lifecycle = sandbox.lifecycle as {
    runtime_timeout_seconds: number;
    idle_timeout_seconds?: number;
    on_runtime_timeout?: "destroy" | "pause";
    on_idle_timeout?: "destroy" | "pause";
  };
  const allOptions = sandbox.providerOptions as Record<string, Record<string, unknown> | undefined>;

  for (const [attemptIndex, providerName] of candidates.entries()) {
    const provider = providers[providerName];
    const options = allOptions[providerName] ?? {};
    const [attempt] = await db
      .insert(providerAttempts)
      .values({
        operationId,
        sandboxId: sandbox.id,
        attemptIndex,
        provider: providerName,
        state: "running",
        startedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [providerAttempts.operationId, providerAttempts.attemptIndex],
        set: { state: "running", startedAt: new Date(), updatedAt: new Date() },
      })
      .returning();
    await appendOperationEvent(db, operationId, "attempt_started", {
      attempt_index: attemptIndex,
      provider: providerName,
    });
    if (!provider) {
      const error = `${providerName} sandbox provider is not configured`;
      await db
        .update(providerAttempts)
        .set({ state: "failed", errorCode: "provider_auth_error", errorMessage: error })
        .where(eq(providerAttempts.id, attempt!.id));
      continue;
    }
    if (provider.capabilities.sources && !provider.capabilities.sources.includes(source.kind)) {
      await db
        .update(providerAttempts)
        .set({
          state: "failed",
          errorCode: "capability_unsupported",
          errorMessage: `${providerName} does not support ${source.kind} sources`,
          outcome: "ineligible",
          completedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      continue;
    }
    try {
      const resolved = resolveProviderResources(
        providerName,
        {
          vcpu: requested.vcpu,
          memoryMb: requested.memory_mb,
          diskMb: requested.disk_mb,
          architecture: requested.architecture ?? "any",
        },
        options,
      );
      const remote = await provider.create({
        metalSandboxId: sandbox.publicId,
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        language: environmentSource.language,
        image: environmentSource.image ?? sandbox.image ?? undefined,
        ttlMinutes: Math.ceil(lifecycle.runtime_timeout_seconds / 60),
        source,
        resources: {
          vcpu: requested.vcpu,
          memoryMb: requested.memory_mb,
          diskMb: requested.disk_mb,
          architecture: requested.architecture ?? "any",
        },
        lifecycle: {
          runtimeTimeoutSeconds: lifecycle.runtime_timeout_seconds,
          idleTimeoutSeconds: lifecycle.idle_timeout_seconds,
          onRuntimeTimeout: lifecycle.on_runtime_timeout ?? "destroy",
          onIdleTimeout: lifecycle.on_idle_timeout ?? "destroy",
        },
        providerOptions: options,
        environment: sandbox.environment,
        secretRefs: sandbox.secretRefs,
        metadata: sandbox.metadata,
      });
      await withTransaction(db, async (tx) => {
        await tx
          .update(providerAttempts)
          .set({
            state: "succeeded",
            providerResourceId: remote.providerResourceId,
            providerMetadata: remote.providerMetadata ?? {},
            resolvedResources: remote.resolvedResources ?? {
              vcpu: resolved.vcpu,
              memoryMb: resolved.memoryMb,
              diskMb: resolved.diskMb,
              architecture: resolved.architecture,
              providerSize: resolved.providerSize,
            },
            outcome: "created",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(providerAttempts.id, attempt!.id));
        const [updated] = await tx
          .update(sandboxes)
          .set({
            provider: providerName,
            status: "ready",
            providerResourceId: remote.providerResourceId,
            providerOrganizationId: remote.providerOrganizationId,
            providerMetadata: remote.providerMetadata ?? {},
            resolvedResources: remote.resolvedResources ?? {
              vcpu: resolved.vcpu,
              memory_mb: resolved.memoryMb,
              disk_mb: resolved.diskMb,
              architecture: resolved.architecture,
              provider_size: resolved.providerSize,
            },
            readyAt: new Date(),
            updatedAt: new Date(),
            errorCode: null,
          })
          .where(eq(sandboxes.id, sandbox.id))
          .returning();
        if (updated) {
          await recordSandboxEvent(tx, updated, "sandbox.ready", { provider: providerName });
          if (provider.capabilities.cost && provider.name !== "northflank") {
            await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
          }
          await tx
            .insert(outboxJobs)
            .values({
              jobType: "sandbox.destroy",
              dedupeKey: `sandbox:destroy:${updated.id}`,
              payload: { job_type: "sandbox.destroy", sandbox_id: updated.id },
              availableAt: new Date(Date.now() + lifecycle.runtime_timeout_seconds * 1_000),
            })
            .onConflictDoNothing();
        }
      });
      await setOperationState(db, operationId, "succeeded");
      return;
    } catch (error) {
      const classification = classifyProviderFailure(error);
      await db
        .update(providerAttempts)
        .set({
          state: classification.unknown ? "reconciling" : "failed",
          errorCode: classification.kind,
          errorMessage: safeError(error),
          outcome: classification.unknown ? "unknown" : "absent",
          completedAt: classification.unknown ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      await appendOperationEvent(db, operationId, "attempt_failed", {
        attempt_index: attemptIndex,
        provider: providerName,
        code: classification.kind,
      });
      if (classification.unknown) {
        let reconciliationCompleted = false;
        const reconciled = provider.reconcileCreate
          ? await provider
              .reconcileCreate(sandbox.publicId)
              .then((result) => {
                reconciliationCompleted = true;
                return result;
              })
              .catch(() => null)
          : null;
        if (reconciled) {
          await db
            .update(providerAttempts)
            .set({
              state: "succeeded",
              providerResourceId: reconciled.providerResourceId,
              providerMetadata: reconciled.providerMetadata ?? {},
              outcome: "found",
              completedAt: new Date(),
            })
            .where(eq(providerAttempts.id, attempt!.id));
          await db
            .update(sandboxes)
            .set({
              provider: providerName,
              status: "ready",
              providerResourceId: reconciled.providerResourceId,
              providerOrganizationId: reconciled.providerOrganizationId,
              providerMetadata: reconciled.providerMetadata ?? {},
              readyAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(sandboxes.id, sandbox.id));
          await setOperationState(db, operationId, "succeeded");
          return;
        }
        if (reconciliationCompleted) {
          continue;
        }
        await db
          .update(sandboxes)
          .set({ status: "provision_unknown", updatedAt: new Date() })
          .where(eq(sandboxes.id, sandbox.id));
        await setOperationState(db, operationId, "reconciling", {
          code: "provider_unknown_outcome",
          message: safeError(error),
          retryable: true,
        });
        return;
      }
      if (!classification.fallbackSafe) {
        break;
      }
    }
  }
  await db
    .update(sandboxes)
    .set({ status: "failed", errorCode: "no_eligible_provider", updatedAt: new Date() })
    .where(eq(sandboxes.id, sandbox.id));
  await setOperationState(db, operationId, "failed", {
    code: "no_eligible_provider",
    message: "all selected providers failed or were ineligible",
    retryable: false,
  });
}

async function destroySandbox(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  operationId?: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "stopped" || sandbox.status === "deleted") {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  const destroyResult = sandbox.providerResourceId
    ? await provider.destroy(sandbox.providerResourceId)
    : undefined;
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "stopped",
        errorCode: null,
        errorMessage: null,
        providerMetadata: {
          ...sandbox.providerMetadata,
          ...(destroyResult?.providerMetadata ?? {}),
        },
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.deleted", {
        provider: provider.name,
      });
      if (provider.capabilities.cost) {
        const availableAt =
          provider.name === "codesandbox" ||
          provider.name === "e2b" ||
          provider.name === "runloop" ||
          provider.name === "vercel"
            ? new Date(Date.now() + 2_000)
            : provider.name === "cloudflare"
              ? new Date(Date.now() + 10 * 60_000)
              : provider.name === "blaxel"
                ? new Date(Date.now() + 5 * 60_000)
                : provider.name === "northflank"
                  ? northflankBillingAvailableAt(updated.deletedAt ?? new Date())
                  : new Date(Date.now() + 120_000);
        await scheduleCostSync(tx, updated.id, availableAt, true);
      }
    }
  });
  await setOperationState(db, operationId, "succeeded");
}

async function pauseSandbox(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  operationId: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "paused" || sandbox.status === "stopped") {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  if (!sandbox.providerResourceId) {
    throw new Error("sandbox has no provider resource");
  }
  await provider.pause(sandbox.providerResourceId);
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "paused",
        errorCode: null,
        errorMessage: null,
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.paused", {
        provider: provider.name,
      });
      if (provider.capabilities.cost) {
        const final = provider.name === "codesandbox" || provider.name === "northflank";
        await scheduleCostSync(
          tx,
          updated.id,
          provider.name === "northflank"
            ? northflankBillingAvailableAt(updated.pausedAt ?? new Date())
            : new Date(Date.now() + 5_000),
          final,
        );
      }
    }
  });
  await setOperationState(db, operationId, "succeeded");
}

async function resumeSandbox(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  operationId: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "ready") {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  if (!sandbox.providerResourceId || !provider.resume) {
    throw new ProviderError("provider does not support resume", "unsupported", false);
  }
  const remote = await provider.resume(sandbox.providerResourceId);
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "ready",
        providerResourceId: remote?.providerResourceId ?? sandbox.providerResourceId,
        providerOrganizationId: remote?.providerOrganizationId ?? sandbox.providerOrganizationId,
        providerMetadata: remote?.providerMetadata ?? sandbox.providerMetadata,
        pausedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.resumed", {
        provider: provider.name,
      });
    }
  });
  await setOperationState(db, operationId, "succeeded");
}

async function syncSandboxCost(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  final: boolean,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox?.providerResourceId) {
    return;
  }
  const measuredAt = new Date();
  const cost = await provider.getCost({
    providerResourceId: sandbox.providerResourceId,
    providerOrganizationId: sandbox.providerOrganizationId ?? undefined,
    providerMetadata: sandbox.providerMetadata,
    from: sandbox.readyAt ?? sandbox.createdAt,
    to:
      provider.name === "codesandbox" && sandbox.pausedAt
        ? sandbox.pausedAt
        : (sandbox.deletedAt ?? sandbox.pausedAt ?? measuredAt),
  });
  if (!cost && final) {
    throw new Error("final provider cost is not available yet");
  }
  await withTransaction(db, async (tx) => {
    if (cost) {
      await tx
        .insert(providerCostSnapshots)
        .values({
          sandboxId: sandbox.id,
          organizationId: sandbox.organizationId,
          projectId: sandbox.projectId,
          provider: provider.name,
          providerResourceId: sandbox.providerResourceId!,
          amountMicrousd: cost.amountMicrousd,
          measuredThrough: cost.measuredThrough,
          rawPayload: cost.raw,
        })
        .onConflictDoNothing();
      const [updated] = await tx
        .update(sandboxes)
        .set({
          providerCostMicrousd: cost.amountMicrousd,
          providerOrganizationId: cost.providerOrganizationId,
          providerCostMeasuredThrough: cost.measuredThrough,
          providerCostUpdatedAt: measuredAt,
          updatedAt: measuredAt,
        })
        .where(eq(sandboxes.id, sandbox.id))
        .returning();
      if (updated) {
        await recordSandboxEvent(tx, updated, "sandbox.cost_updated", {
          provider: provider.name,
          cost_microusd: cost.amountMicrousd.toString(),
          cost_updated_at: measuredAt.toISOString(),
        });
      }
    }
    if (!final && sandbox.status !== "deleted") {
      const delayMs = sandbox.status === "paused" ? 5 * 60_000 : 60_000;
      await scheduleCostSync(tx, sandbox.id, new Date(Date.now() + delayMs), false);
    }
  });
}

async function recordTerminalSandboxFailure(
  db: MetalDb,
  payload: Exclude<OutboxJobPayload, { job_type: "realtime.broadcast" }>,
) {
  if (payload.job_type === "sandbox.cost.sync") {
    return;
  }
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, payload.sandbox_id))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "stopped" || sandbox.status === "deleted") {
    return;
  }
  const status =
    payload.job_type === "sandbox.destroy"
      ? "cleanup_failed"
      : payload.job_type === "sandbox.pause"
        ? "ready"
        : payload.job_type === "sandbox.resume"
          ? "paused"
          : "failed";
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status,
        errorCode: `${payload.job_type.replace(".", "_")}_failed`,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.failed", {
        operation: payload.job_type,
        error_code: updated.errorCode,
      });
    }
  });
}

async function resolveSandboxProvider(
  db: MetalDb,
  providers: SandboxProviders,
  sandboxId: string,
): Promise<SandboxProvider> {
  const sandbox = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  const provider = sandbox ? providers[sandbox.provider as SandboxProviderName] : undefined;
  if (!provider) {
    throw new Error(
      sandbox ? `${sandbox.provider} sandbox provider is not configured` : "sandbox not found",
    );
  }
  return provider;
}

export async function processOnce(
  db: MetalDb,
  publisher: BroadcastPublisher,
  env: WorkerEnv,
  providers: SandboxProviders = {},
): Promise<number> {
  const logger = createLogger({
    service: "worker",
    environment: env.METAL_ENVIRONMENT,
    level: env.LOG_LEVEL,
  });
  const jobs = await claimOutboxJobs(db, {
    workerId: env.WORKER_ID,
    limit: env.WORKER_BATCH_SIZE,
    leaseMs: env.WORKER_LEASE_MS,
  });

  for (const job of jobs) {
    const child = logger.child({
      job_id: job.id,
      service: "worker",
      environment: env.METAL_ENVIRONMENT,
    });
    let payload: OutboxJobPayload | undefined;
    try {
      payload = OutboxJobPayloadSchema.parse(job.payload);
      if (payload.job_type === "realtime.broadcast") {
        await publisher.publish(payload.topic, payload.event.type, payload.event);
      } else {
        if (payload.job_type === "sandbox.provision") {
          await provisionSandbox(db, providers, payload.sandbox_id, payload.operation_id);
        } else if (payload.job_type === "sandbox.reconcile") {
          await provisionSandbox(db, providers, payload.sandbox_id, payload.operation_id);
        } else if (payload.job_type === "sandbox.pause") {
          const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
          await pauseSandbox(db, sandboxProvider, payload.sandbox_id, payload.operation_id);
        } else if (payload.job_type === "sandbox.resume") {
          const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
          await resumeSandbox(db, sandboxProvider, payload.sandbox_id, payload.operation_id);
        } else if (payload.job_type === "sandbox.cost.sync") {
          const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
          await syncSandboxCost(db, sandboxProvider, payload.sandbox_id, payload.final);
        } else {
          const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
          await destroySandbox(db, sandboxProvider, payload.sandbox_id, payload.operation_id);
        }
      }
      await db
        .update(outboxJobs)
        .set({
          status: "succeeded",
          completedAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
          leaseOwner: env.WORKER_ID,
        })
        .where(
          and(
            eq(outboxJobs.id, job.id),
            eq(outboxJobs.status, "leased"),
            eq(outboxJobs.leaseOwner, env.WORKER_ID),
          ),
        );
      child.info({ job_id: job.id, job_type: payload.job_type }, "processed outbox job");
    } catch (error) {
      const attempts = job.attemptCount;
      const terminal = attempts >= env.WORKER_MAX_ATTEMPTS;
      const retryDelayMs =
        payload?.job_type === "sandbox.cost.sync" && payload.final
          ? 2 * 60_000
          : backoffMs(attempts, env.WORKER_BASE_BACKOFF_MS);
      if (terminal && payload && payload.job_type !== "realtime.broadcast") {
        await recordTerminalSandboxFailure(db, payload);
        if ("operation_id" in payload && payload.operation_id) {
          await setOperationState(db, payload.operation_id, "failed", {
            code: "operation_failed",
            message: safeError(error),
            retryable: false,
          });
        }
      }
      await db
        .update(outboxJobs)
        .set({
          status: terminal ? "failed" : "pending",
          lastError: safeError(error),
          availableAt: terminal ? new Date() : new Date(Date.now() + retryDelayMs),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
          completedAt: terminal ? new Date() : null,
        })
        .where(
          and(
            eq(outboxJobs.id, job.id),
            eq(outboxJobs.status, "leased"),
            eq(outboxJobs.leaseOwner, env.WORKER_ID),
          ),
        );
      child.warn(
        { job_id: job.id, attempt: attempts, terminal, err: safeError(error) },
        "outbox job failed",
      );
    }
  }

  return jobs.length;
}

async function scheduleMissingSandboxCosts(db: MetalDb, providers: SandboxProviders, now: Date) {
  const activeJobs = await db
    .select({ payload: outboxJobs.payload })
    .from(outboxJobs)
    .where(
      and(
        eq(outboxJobs.jobType, "sandbox.cost.sync"),
        inArray(outboxJobs.status, ["pending", "leased"]),
      ),
    );
  const activeSandboxIds = new Set<string>();
  for (const job of activeJobs) {
    const parsed = OutboxJobPayloadSchema.safeParse(job.payload);
    if (parsed.success && parsed.data.job_type === "sandbox.cost.sync") {
      activeSandboxIds.add(parsed.data.sandbox_id);
    }
  }

  const missingCosts = await db
    .select({
      id: sandboxes.id,
      status: sandboxes.status,
      provider: sandboxes.provider,
      pausedAt: sandboxes.pausedAt,
      deletedAt: sandboxes.deletedAt,
    })
    .from(sandboxes)
    .where(
      and(
        isNotNull(sandboxes.providerResourceId),
        sql`(
          ${sandboxes.providerCostUpdatedAt} is null
          or (
            ${sandboxes.status} = 'deleted'
            and ${sandboxes.deletedAt} is not null
            and (
              ${sandboxes.providerCostMeasuredThrough} is null
              or ${sandboxes.providerCostMeasuredThrough} < ${sandboxes.deletedAt}
            )
          )
          or (
            ${sandboxes.status} = 'paused'
            and ${sandboxes.pausedAt} is not null
            and (
              ${sandboxes.providerCostMeasuredThrough} is null
              or ${sandboxes.providerCostMeasuredThrough} < ${sandboxes.pausedAt}
            )
          )
        )`,
      ),
    );
  for (const sandbox of missingCosts) {
    if (activeSandboxIds.has(sandbox.id)) {
      continue;
    }
    const provider = providers[sandbox.provider as SandboxProviderName];
    if (!provider?.capabilities.cost) {
      continue;
    }
    if (provider.name === "northflank" && sandbox.status === "ready") {
      continue;
    }
    const final =
      sandbox.status === "deleted" ||
      ((provider.name === "codesandbox" || provider.name === "northflank") &&
        sandbox.status === "paused");
    const measuredThrough = sandbox.deletedAt ?? sandbox.pausedAt;
    const providerAvailableAt =
      provider.name === "northflank" && final && measuredThrough
        ? northflankBillingAvailableAt(measuredThrough)
        : now;
    await scheduleCostSync(
      db,
      sandbox.id,
      new Date(Math.max(providerAvailableAt.getTime(), now.getTime())),
      final,
    );
  }
}

export async function runWorkerLoop(
  db: MetalDb,
  publisher: BroadcastPublisher,
  env: WorkerEnv,
  signal: AbortSignal,
  providers: SandboxProviders = {},
): Promise<void> {
  let nextCostSweepAt = 0;
  while (!signal.aborted) {
    const now = Date.now();
    if (now >= nextCostSweepAt) {
      const sweepBucket = Math.floor(now / env.WORKER_COST_SWEEP_MS) * env.WORKER_COST_SWEEP_MS;
      await scheduleMissingSandboxCosts(db, providers, new Date(sweepBucket));
      nextCostSweepAt = sweepBucket + env.WORKER_COST_SWEEP_MS;
    }
    await processOnce(db, publisher, env, providers);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, env.WORKER_POLL_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}
