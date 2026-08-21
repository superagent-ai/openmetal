import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  claimOutboxJobs,
  domainEvents,
  outboxJobs,
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
import type { SandboxProvider, SandboxProviderName } from "@openmetal/provider-core";
import type { WorkerEnv } from "./env.js";
import type { BroadcastPublisher } from "./publisher.js";

type SandboxProviders = Partial<Record<SandboxProviderName, SandboxProvider>>;

function backoffMs(attempt: number, base: number): number {
  const exp = Math.min(base * 2 ** Math.max(attempt - 1, 0), 30_000);
  return Math.round(exp * (0.5 + Math.random()));
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return redactString(error.message.slice(0, 500));
  }
  return "unknown error";
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
    projectId: event.projectId,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
  await tx.insert(outboxJobs).values({
    jobType: "realtime.broadcast",
    dedupeKey: publicationDedupeKey(event.eventId),
    payload: {
      job_type: "realtime.broadcast",
      topic: projectTopic(sandbox.projectId),
      event: publicEvent,
    },
  });
}

async function provisionSandbox(db: MetalDb, provider: SandboxProvider, sandboxId: string) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (
    !sandbox ||
    sandbox.status === "ready" ||
    sandbox.status === "deleting" ||
    sandbox.status === "deleted"
  ) {
    return;
  }
  if (sandbox.status === "requested") {
    await db
      .update(sandboxes)
      .set({ status: "provisioning", updatedAt: new Date() })
      .where(and(eq(sandboxes.id, sandbox.id), eq(sandboxes.status, "requested")));
  }
  const remote = await provider.create({
    metalSandboxId: sandbox.id,
    organizationId: sandbox.organizationId,
    projectId: sandbox.projectId,
    language: sandbox.language,
    image: sandbox.image ?? undefined,
    ttlMinutes: sandbox.ttlMinutes,
  });
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "ready",
        providerResourceId: remote.providerResourceId,
        providerOrganizationId: remote.providerOrganizationId,
        readyAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.ready", { provider: provider.name });
      if (provider.capabilities.cost) {
        await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
      }
    }
  });
}

async function destroySandbox(db: MetalDb, provider: SandboxProvider, sandboxId: string) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "deleted") {
    return;
  }
  if (sandbox.providerResourceId) {
    await provider.destroy(sandbox.providerResourceId);
  }
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.deleted", {
        provider: provider.name,
      });
      if (provider.capabilities.cost) {
        await scheduleCostSync(tx, updated.id, new Date(Date.now() + 120_000), true);
      }
    }
  });
}

async function pauseSandbox(db: MetalDb, provider: SandboxProvider, sandboxId: string) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "paused" || sandbox.status === "deleted") {
    return;
  }
  if (!sandbox.providerResourceId) {
    throw new Error("sandbox has no provider resource");
  }
  await provider.pause(sandbox.providerResourceId);
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.paused", {
        provider: provider.name,
      });
      if (provider.capabilities.cost) {
        await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
      }
    }
  });
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
    from: sandbox.createdAt,
    to: measuredAt,
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
          provider_cost_microusd: cost.amountMicrousd.toString(),
          provider_cost_updated_at: measuredAt.toISOString(),
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
  if (!sandbox || sandbox.status === "deleted") {
    return;
  }
  const status =
    payload.job_type === "sandbox.destroy"
      ? "cleanup_failed"
      : payload.job_type === "sandbox.pause"
        ? "ready"
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
        const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
        if (payload.job_type === "sandbox.provision") {
          await provisionSandbox(db, sandboxProvider, payload.sandbox_id);
        } else if (payload.job_type === "sandbox.pause") {
          await pauseSandbox(db, sandboxProvider, payload.sandbox_id);
        } else if (payload.job_type === "sandbox.cost.sync") {
          await syncSandboxCost(db, sandboxProvider, payload.sandbox_id, payload.final);
        } else {
          await destroySandbox(db, sandboxProvider, payload.sandbox_id);
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
      if (terminal && payload && payload.job_type !== "realtime.broadcast") {
        await recordTerminalSandboxFailure(db, payload);
      }
      await db
        .update(outboxJobs)
        .set({
          status: terminal ? "failed" : "pending",
          lastError: safeError(error),
          availableAt: terminal
            ? new Date()
            : new Date(Date.now() + backoffMs(attempts, env.WORKER_BASE_BACKOFF_MS)),
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

export async function runWorkerLoop(
  db: MetalDb,
  publisher: BroadcastPublisher,
  env: WorkerEnv,
  signal: AbortSignal,
  providers: SandboxProviders = {},
): Promise<void> {
  const missingCosts = await db
    .select({
      id: sandboxes.id,
      status: sandboxes.status,
      provider: sandboxes.provider,
    })
    .from(sandboxes)
    .where(and(isNotNull(sandboxes.providerResourceId), isNull(sandboxes.providerCostUpdatedAt)));
  for (const sandbox of missingCosts) {
    const provider = providers[sandbox.provider as SandboxProviderName];
    if (provider?.capabilities.cost) {
      await scheduleCostSync(db, sandbox.id, new Date(), sandbox.status === "deleted");
    }
  }
  while (!signal.aborted) {
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
