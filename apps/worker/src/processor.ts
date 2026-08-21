import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
        providerMetadata: remote.providerMetadata ?? {},
        readyAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.ready", { provider: provider.name });
      if (provider.capabilities.cost && provider.name !== "northflank") {
        await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
      }
      if (
        provider.name === "cloudflare" ||
        provider.name === "northflank" ||
        provider.name === "runloop"
      ) {
        await tx
          .insert(outboxJobs)
          .values({
            jobType: "sandbox.destroy",
            dedupeKey: `sandbox:destroy:${updated.id}`,
            payload: {
              job_type: "sandbox.destroy",
              sandbox_id: updated.id,
            },
            availableAt: new Date(Date.now() + updated.ttlMinutes * 60_000),
          })
          .onConflictDoNothing();
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
  const destroyResult = sandbox.providerResourceId
    ? await provider.destroy(sandbox.providerResourceId)
    : undefined;
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "deleted",
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
          provider.name === "e2b" || provider.name === "runloop" || provider.name === "vercel"
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
        await scheduleCostSync(
          tx,
          updated.id,
          provider.name === "northflank"
            ? northflankBillingAvailableAt(updated.pausedAt ?? new Date())
            : new Date(Date.now() + 5_000),
          provider.name === "northflank",
        );
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
    providerMetadata: sandbox.providerMetadata,
    from: sandbox.readyAt ?? sandbox.createdAt,
    to: sandbox.deletedAt ?? sandbox.pausedAt ?? measuredAt,
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
      const retryDelayMs =
        payload?.job_type === "sandbox.cost.sync" && payload.final
          ? 2 * 60_000
          : backoffMs(attempts, env.WORKER_BASE_BACKOFF_MS);
      if (terminal && payload && payload.job_type !== "realtime.broadcast") {
        await recordTerminalSandboxFailure(db, payload);
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
      (provider.name === "northflank" && sandbox.status === "paused");
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
