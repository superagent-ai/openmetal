import { sql } from "drizzle-orm";
import type { MetalDb } from "./client.js";
import type { outboxJobs } from "./schema.js";

export type ClaimedJob = typeof outboxJobs.$inferSelect;

export async function claimOutboxJobs(
  db: MetalDb,
  input: { workerId: string; limit: number; leaseMs: number },
): Promise<ClaimedJob[]> {
  const result = await db.execute(sql`
    with picked as (
      select id
      from metal.outbox_jobs
      where available_at <= now()
        and (
          status = 'pending'
          or (status = 'leased' and lease_expires_at < now())
        )
      order by created_at asc
      for update skip locked
      limit ${input.limit}
    )
    update metal.outbox_jobs as jobs
    set
      status = 'leased',
      lease_owner = ${input.workerId},
      lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond'),
      attempt_count = jobs.attempt_count + 1,
      updated_at = now()
    from picked
    where jobs.id = picked.id
    returning
      jobs.id,
      jobs.job_type as "jobType",
      jobs.dedupe_key as "dedupeKey",
      jobs.payload,
      jobs.status,
      jobs.attempt_count as "attemptCount",
      jobs.available_at as "availableAt",
      jobs.lease_owner as "leaseOwner",
      jobs.lease_expires_at as "leaseExpiresAt",
      jobs.last_error as "lastError",
      jobs.created_at as "createdAt",
      jobs.updated_at as "updatedAt",
      jobs.completed_at as "completedAt"
  `);

  return result as unknown as ClaimedJob[];
}
