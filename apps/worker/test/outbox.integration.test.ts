import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";
import { serializeCursor } from "@openmetal/events";
import { createConfirmedUser, deleteUser, loadTestEnv } from "@openmetal/testkit";
import { processOnce } from "../src/processor.js";
import { loadWorkerEnv } from "../src/env.js";

const env = loadTestEnv();

describe("worker outbox", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  const users: string[] = [];

  beforeAll(async () => {
    const ready = await database.ready();
    expect(ready).toBe(true);
  });

  afterAll(async () => {
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await database.shutdown();
  });

  async function processUntilJob(
    jobId: string,
    publisher: { publish: (topic: string, type: string, event: unknown) => Promise<void> },
    workerEnv: ReturnType<typeof loadWorkerEnv>,
    predicate: (row: { status: string; attempt_count: number | string }) => boolean,
  ) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await processOnce(database.db, publisher, workerEnv);
      const [row] = await database.sql`
        select status, attempt_count from metal.outbox_jobs where id = ${jobId}
      `;
      if (row && predicate(row)) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`outbox job ${jobId} did not reach the expected state`);
  }

  it("claims with skip locked, retries, and does not duplicate domain events", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const eventId = crypto.randomUUID();

    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Worker Org', ${`w-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${orgId}, ${user.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, organization_id, name, slug)
      values (${projectId}, ${orgId}, 'Worker Project', ${`p-${projectId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into metal.domain_events (event_id, type, organization_id, project_id, payload, actor_id)
      values (
        ${eventId},
        'project.created',
        ${orgId},
        ${projectId},
        ${JSON.stringify({ name: "Worker Project" })}::jsonb,
        ${user.user.id}
      )
    `;
    const cursor = serializeCursor(1);
    const payload = {
      job_type: "realtime.broadcast",
      topic: `project:${projectId}`,
      event: {
        cursor,
        event_id: eventId,
        type: "project.created",
        organization_id: orgId,
        project_id: projectId,
        occurred_at: new Date().toISOString(),
        data: { name: "Worker Project" },
      },
    };
    const [job] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values ('realtime.broadcast', ${`broadcast:${eventId}`}, ${JSON.stringify(payload)}::jsonb, 'pending')
      returning id
    `;
    expect(job?.id).toBeTruthy();
    if (!job) {
      throw new Error("outbox job insert did not return an id");
    }
    const jobId = String(job.id);

    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "test-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "2",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });

    let attempts = 0;
    const failingPublisher = {
      publish: async () => {
        attempts += 1;
        throw new Error("transient");
      },
    };
    await processUntilJob(
      jobId,
      failingPublisher,
      workerEnv,
      (row) => Number(row.attempt_count) >= 1,
    );
    expect(attempts).toBeGreaterThanOrEqual(1);
    const afterFail = await database.sql`
      select status, attempt_count from metal.outbox_jobs where id = ${jobId}
    `;
    expect(Number(afterFail[0]?.attempt_count)).toBeGreaterThanOrEqual(1);
    expect(afterFail[0]?.status).toBe("pending");

    await processUntilJob(
      jobId,
      failingPublisher,
      {
        ...workerEnv,
        WORKER_MAX_ATTEMPTS: 1,
      },
      (row) => row.status === "failed" || Number(row.attempt_count) >= 2,
    );
    expect(attempts).toBeGreaterThanOrEqual(2);

    let published = 0;
    const okPublisher = {
      publish: async (topic: string) => {
        if (topic === `project:${projectId}`) {
          published += 1;
        }
      },
    };
    await database.sql`
      update metal.outbox_jobs
      set status = 'pending', available_at = now(), attempt_count = 0, completed_at = null
      where id = ${jobId}
    `;
    await processUntilJob(jobId, okPublisher, workerEnv, (row) => row.status === "succeeded");
    expect(published).toBe(1);

    const events = await database.sql`
      select count(*)::int as count from metal.domain_events where event_id = ${eventId}
    `;
    expect(events[0]?.count).toBe(1);
  });

  it("recovers expired leases after a worker crash", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Lease Org', ${`l-${orgId.slice(0, 8)}`})
    `;
    const eventId = crypto.randomUUID();
    const payload = {
      job_type: "realtime.broadcast",
      topic: `organization:${orgId}`,
      event: {
        cursor: serializeCursor(2),
        event_id: eventId,
        type: "organization.created",
        organization_id: orgId,
        occurred_at: new Date().toISOString(),
        data: {},
      },
    };
    const [job] = await database.sql`
      insert into metal.outbox_jobs (
        job_type, dedupe_key, payload, status, lease_owner, lease_expires_at, attempt_count
      )
      values (
        'realtime.broadcast',
        ${`broadcast:${eventId}`},
        ${JSON.stringify(payload)}::jsonb,
        'leased',
        'dead-worker',
        now() - interval '1 second',
        1
      )
      returning id
    `;
    expect(job?.id).toBeTruthy();
    if (!job) {
      throw new Error("outbox job insert did not return an id");
    }
    const jobId = String(job.id);

    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "recovery-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "8",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    let published = 0;
    await processUntilJob(
      jobId,
      {
        publish: async (topic) => {
          if (topic === `organization:${orgId}`) {
            published += 1;
          }
        },
      },
      workerEnv,
      (row) => row.status === "succeeded",
    );
    expect(published).toBe(1);
    const row = await database.sql`select status from metal.outbox_jobs where id = ${jobId}`;
    expect(row[0]?.status).toBe("succeeded");
  });
});
