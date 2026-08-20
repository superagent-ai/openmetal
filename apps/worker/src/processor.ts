import { and, eq } from "drizzle-orm";
import { claimOutboxJobs, outboxJobs, type MetalDb } from "@openmetal/db";
import { createLogger, redactString } from "@openmetal/logger";
import type { WorkerEnv } from "./env.js";
import { parseJobPayload, type BroadcastPublisher } from "./publisher.js";

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

export async function processOnce(
  db: MetalDb,
  publisher: BroadcastPublisher,
  env: WorkerEnv,
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
    try {
      const payload = parseJobPayload(job.payload);
      await publisher.publish(payload.topic, payload.event.type, payload.event);
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
      child.info({ job_id: job.id, event_id: payload.event.event_id }, "published event");
    } catch (error) {
      const attempts = job.attemptCount;
      const terminal = attempts >= env.WORKER_MAX_ATTEMPTS;
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
        "publish failed",
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
): Promise<void> {
  while (!signal.aborted) {
    await processOnce(db, publisher, env);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, env.WORKER_POLL_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}
