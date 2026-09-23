import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  claimOutboxJobs,
  createDatabase,
  enqueueWebhookDeliveries,
  insertDomainEventAndBroadcast,
} from "@openmetal/db";
import { serializeCursor } from "@openmetal/events";
import { verifyWebhookSignature } from "@openmetal/events/webhooks-node";
import {
  createConfirmedUser,
  deleteUser,
  FakeSandboxProvider,
  loadTestEnv,
} from "@openmetal/testkit";
import { processOnce } from "../src/processor.js";
import { loadWorkerEnv } from "../src/env.js";
import {
  getByokProviderByCredentialId,
  listOrganizationByokProviders,
} from "../src/provider-credentials.js";

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
    providers: NonNullable<Parameters<typeof processOnce>[3]> = {},
    stripe: Parameters<typeof processOnce>[4] = null,
  ) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await processOnce(database.db, publisher, workerEnv, providers, stripe);
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
    const projectPublicId = `prj_${projectId.replaceAll("-", "")}`;
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
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (${projectId}, ${projectPublicId}, ${orgId}, 'Worker Project', ${`p-${projectId.slice(0, 8)}`})
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
      topic: `project:${projectPublicId}`,
      event: {
        cursor,
        event_id: eventId,
        type: "project.created",
        organization_id: orgId,
        project_id: projectPublicId,
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
        throw new Error("Bearer secret-token");
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
      select status, attempt_count, last_error from metal.outbox_jobs where id = ${jobId}
    `;
    expect(Number(afterFail[0]?.attempt_count)).toBeGreaterThanOrEqual(1);
    expect(afterFail[0]?.status).toBe("pending");
    expect(afterFail[0]?.last_error).toBe("[REDACTED]");

    await processUntilJob(
      jobId,
      failingPublisher,
      {
        ...workerEnv,
        WORKER_MAX_ATTEMPTS: 1,
      },
      (row) => row.status === "failed",
    );
    expect(attempts).toBeGreaterThanOrEqual(2);
    const terminal = await database.sql`
      select status, attempt_count, last_error from metal.outbox_jobs where id = ${jobId}
    `;
    expect(terminal[0]?.status).toBe("failed");
    expect(Number(terminal[0]?.attempt_count)).toBeGreaterThanOrEqual(2);
    expect(terminal[0]?.last_error).toBe("[REDACTED]");

    let published = 0;
    const okPublisher = {
      publish: async (topic: string) => {
        if (topic === `project:${projectPublicId}`) {
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

    await database.sql`
      update metal.outbox_jobs
      set status = 'pending', available_at = now(), completed_at = null
      where id = ${jobId}
    `;
    await processUntilJob(jobId, okPublisher, workerEnv, (row) => row.status === "succeeded");
    expect(published).toBe(2);

    const events = await database.sql`
      select count(*)::int as count from metal.domain_events where event_id = ${eventId}
    `;
    expect(events[0]?.count).toBe(1);
  });

  it("loads encrypted BYOK credentials without exposing them through the database model", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    const secretName = `worker-byok-${crypto.randomUUID()}`;
    const apiKey = `secret-${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      provider: "e2b",
      api_key: apiKey,
    });
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Worker BYOK Org', ${`wb-${orgId.slice(0, 8)}`})
    `;
    const [credential] = await database.sql`
      with secret as (
        select vault.create_secret(${payload}, ${secretName}, 'Worker BYOK test') as id
      )
      insert into metal.organization_provider_credentials (
        organization_id, provider, secret_id, created_by
      )
      select ${orgId}, 'e2b', secret.id, ${user.user.id}
      from secret
      returning id, secret_id
    `;
    expect(credential?.id).toBeTruthy();
    const invalidPayload = JSON.stringify({ provider: "daytona" });
    const [invalidCredential] = await database.sql`
      with secret as (
        select vault.create_secret(
          ${invalidPayload},
          ${`worker-invalid-byok-${crypto.randomUUID()}`},
          'Invalid Worker BYOK test'
        ) as id
      )
      insert into metal.organization_provider_credentials (
        organization_id, provider, secret_id, created_by
      )
      select ${orgId}, 'daytona', secret.id, ${user.user.id}
      from secret
      returning id, secret_id
    `;
    expect(invalidCredential?.id).toBeTruthy();

    const provider = await getByokProviderByCredentialId(database.db, String(credential!.id));
    expect(provider.name).toBe("e2b");
    const listedProviders = await listOrganizationByokProviders(database.db, orgId);
    expect(listedProviders).toMatchObject({
      e2b: { credentialId: credential!.id },
      daytona: { credentialId: invalidCredential!.id, invalid: true },
    });
    expect(listedProviders.e2b?.provider?.name).toBe("e2b");
    expect(listedProviders.daytona?.provider).toBeUndefined();
    const [stored] = await database.sql`
      select secret, decrypted_secret
      from vault.decrypted_secrets
      where id = ${credential!.secret_id}
    `;
    expect(String(stored!.secret)).not.toContain(apiKey);
    expect(stored!.decrypted_secret).toBe(payload);

    await database.sql`
      delete from metal.organization_provider_credentials where id = ${invalidCredential!.id}
    `;
    await database.sql`
      update metal.organization_provider_credentials
      set disabled_at = now()
      where id = ${credential!.id}
    `;
    await expect(listOrganizationByokProviders(database.db, orgId)).resolves.toEqual({});
    await expect(
      getByokProviderByCredentialId(database.db, String(credential!.id)),
    ).resolves.toMatchObject({ name: "e2b" });

    await database.sql`
      delete from metal.organization_provider_credentials where id = ${credential!.id}
    `;
    const orphaned = await database.sql`
      select id from vault.secrets where id = ${credential!.secret_id}
    `;
    expect(orphaned).toHaveLength(0);
  });

  it("falls back in caller order after a safe provider failure", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sandboxId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Fallback Org', ${`f-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${orgId}, ${user.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId},
        ${`prj_${projectId.replaceAll("-", "")}`},
        ${orgId},
        'Fallback Project',
        ${`p-${projectId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by
      )
      values (
        ${sandboxId},
        ${`sbx_${sandboxId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        'codesandbox',
        'auto',
        'routing',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${user.user.id}
      )
    `;
    await database.sql`
      insert into metal.operations (
        id, public_id, organization_id, project_id, sandbox_id, type, state
      )
      values (
        ${operationId},
        ${`op_${operationId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        ${sandboxId},
        'sandbox_create',
        'queued'
      )
    `;
    await database.sql`
      insert into metal.operation_events (operation_id, sequence, type, data)
      values (${operationId}, 1, 'queued', '{}'::jsonb)
    `;
    const [job] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'sandbox.provision',
        ${`sandbox:provision:${sandboxId}`},
        ${JSON.stringify({
          job_type: "sandbox.provision",
          sandbox_id: sandboxId,
          operation_id: operationId,
        })}::jsonb
      )
      returning id
    `;
    const primary = new FakeSandboxProvider("codesandbox", {
      failures: [{ kind: "capacity", retryable: true }],
    });
    const fallback = new FakeSandboxProvider("e2b");
    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "fallback-worker",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    await processUntilJob(
      String(job!.id),
      { publish: async () => undefined },
      workerEnv,
      (row) => row.status === "succeeded",
      { codesandbox: primary, e2b: fallback },
    );
    const [result] = await database.sql`
      select s.provider, s.status, o.state,
        (select count(*)::int from metal.provider_attempts a where a.operation_id = ${operationId}) attempts
      from metal.sandboxes s
      join metal.operations o on o.sandbox_id = s.id
      where s.id = ${sandboxId}
    `;
    expect(result).toMatchObject({
      provider: "e2b",
      status: "ready",
      state: "succeeded",
      attempts: 2,
    });
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
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'realtime.broadcast',
        ${`broadcast:${eventId}`},
        ${JSON.stringify(payload)}::jsonb,
        'pending'
      )
      returning id
    `;
    expect(job?.id).toBeTruthy();
    if (!job) {
      throw new Error("outbox job insert did not return an id");
    }
    const jobId = String(job.id);
    const claimed = await claimOutboxJobs(database.db, {
      workerId: "dead-worker",
      limit: 100,
      leaseMs: 10,
    });
    expect(claimed.some((candidate) => candidate.id === jobId)).toBe(true);
    const [leased] = await database.sql`
      select status, lease_owner from metal.outbox_jobs where id = ${jobId}
    `;
    expect(leased).toMatchObject({ status: "leased", lease_owner: "dead-worker" });
    await new Promise((resolve) => setTimeout(resolve, 25));

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

  it("does not let a stale worker overwrite a reclaimed lease", async () => {
    const organizationId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const payload = {
      job_type: "realtime.broadcast",
      topic: `organization:${organizationId}`,
      event: {
        cursor: serializeCursor(3),
        event_id: eventId,
        type: "organization.created",
        organization_id: organizationId,
        occurred_at: new Date().toISOString(),
        data: {},
      },
    };
    const [job] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'realtime.broadcast',
        ${`broadcast:${eventId}`},
        ${JSON.stringify(payload)}::jsonb,
        'pending'
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
      WORKER_ID: "stale-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "8",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });

    await processOnce(
      database.db,
      {
        publish: async () => {
          await database.sql`
            update metal.outbox_jobs
            set lease_owner = 'successor-worker', lease_expires_at = now() + interval '5 seconds'
            where id = ${jobId}
          `;
        },
      },
      workerEnv,
    );

    const [row] = await database.sql`
      select status, lease_owner, completed_at
      from metal.outbox_jobs
      where id = ${jobId}
    `;
    expect(row).toMatchObject({
      status: "leased",
      lease_owner: "successor-worker",
      completed_at: null,
    });
  });

  it("charges managed usage from durable cost snapshots without double counting", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sandboxId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Billing Worker Org', ${`bw-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${orgId}, ${user.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId},
        ${`prj_${projectId.replaceAll("-", "")}`},
        ${orgId},
        'Billing Worker Project',
        ${`p-${projectId.slice(0, 8)}`}
      )
    `;
    const { grantCredits } = await import("@openmetal/billing");
    const { withTransaction } = await import("@openmetal/db");
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, {
        organizationId: orgId,
        creditMicrousd: 1_000_000n,
        actorId: user.user.id,
      }),
    );
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by,
        provider_resource_id, billing_mode, ready_at
      )
      values (
        ${sandboxId},
        ${`sbx_${sandboxId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        'e2b',
        'e2b',
        'ready',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${user.user.id},
        ${`fake-sbx_${sandboxId.replaceAll("-", "")}`},
        'managed',
        now()
      )
    `;
    const [job] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'sandbox.cost.sync',
        ${`sandbox:cost:${sandboxId}:test`},
        ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: sandboxId, final: true })}::jsonb,
        'pending'
      )
      returning id
    `;
    const provider = new FakeSandboxProvider("e2b");
    provider.setCost(250_000n);
    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "billing-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "8",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    await processUntilJob(
      String(job!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
    );
    const [account] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(Number(account?.balance_microusd)).toBe(750_000);
    await processOnce(database.db, { publish: async () => {} }, workerEnv, { e2b: provider });
    const [unchanged] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(Number(unchanged?.balance_microusd)).toBe(750_000);
  });

  it("stops recurring cost syncs once a sandbox is stopped", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const readyId = crypto.randomUUID();
    const stoppedId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Cost Chain Org', ${`cc-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${orgId}, ${user.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId},
        ${`prj_${projectId.replaceAll("-", "")}`},
        ${orgId},
        'Cost Chain Project',
        ${`p-${projectId.slice(0, 8)}`}
      )
    `;
    for (const [id, status] of [
      [readyId, "ready"],
      [stoppedId, "stopped"],
    ] as const) {
      await database.sql`
        insert into metal.sandboxes (
          id, public_id, organization_id, project_id, provider, primary_provider,
          status, source, resource_requirements, lifecycle, fallback,
          provider_options, environment, secret_refs, metadata, created_by,
          provider_resource_id, billing_mode, ready_at, deleted_at
        )
        values (
          ${id},
          ${`sbx_${id.replaceAll("-", "")}`},
          ${orgId},
          ${projectId},
          'e2b',
          'e2b',
          ${status},
          ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
          ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
          ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
          ${JSON.stringify({ providers: [] })}::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          ${user.user.id},
          ${`fake-sbx_${id.replaceAll("-", "")}`},
          'byok',
          now() - interval '10 minutes',
          ${status === "stopped" ? new Date().toISOString() : null}
        )
      `;
    }
    const jobs = await Promise.all(
      [readyId, stoppedId].map(async (id) => {
        const [job] = await database.sql`
          insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
          values (
            'sandbox.cost.sync',
            ${`sandbox:cost:${id}:chain`},
            ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: id, final: false })}::jsonb,
            'pending'
          )
          returning id
        `;
        return String(job!.id);
      }),
    );
    const provider = new FakeSandboxProvider("e2b");
    provider.setCost(40_000n);
    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "cost-chain-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "8",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    for (const jobId of jobs) {
      await processUntilJob(
        jobId,
        { publish: async () => {} },
        workerEnv,
        (row) => row.status === "succeeded",
        { e2b: provider },
      );
    }

    const pendingSyncs = await database.sql`
      select payload->>'sandbox_id' as sandbox_id, count(*)::int as count
      from metal.outbox_jobs
      where job_type = 'sandbox.cost.sync'
        and status = 'pending'
        and payload->>'sandbox_id' in (${readyId}, ${stoppedId})
      group by 1
    `;
    const pendingBySandbox = new Map(
      pendingSyncs.map((row) => [String(row.sandbox_id), Number(row.count)]),
    );
    expect(pendingBySandbox.get(readyId)).toBe(1);
    expect(pendingBySandbox.get(stoppedId)).toBeUndefined();

    const [stopped] = await database.sql`
      select provider_cost_microusd from metal.sandboxes where id = ${stoppedId}
    `;
    expect(Number(stopped?.provider_cost_microusd)).toBe(40_000);
    const [events] = await database.sql`
      select count(*)::int as count
      from metal.domain_events
      where type = 'sandbox.cost_updated'
        and payload->>'sandbox_id' = ${`sbx_${stoppedId.replaceAll("-", "")}`}
    `;
    expect(Number(events?.count)).toBe(1);
  });

  it("observes BYOK cost without charging, corrects usage, tops up, and enforces spend", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const managedId = crypto.randomUUID();
    const byokId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Spend Limit Org', ${`sl-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${orgId}, ${user.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId},
        ${`prj_${projectId.replaceAll("-", "")}`},
        ${orgId},
        'Spend Limit Project',
        ${`p-${projectId.slice(0, 8)}`}
      )
    `;
    const { FakeStripeGateway, grantCredits, handleStripeWebhook } =
      await import("@openmetal/billing");
    const { withTransaction } = await import("@openmetal/db");
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, {
        organizationId: orgId,
        creditMicrousd: 400_000n,
        actorId: user.user.id,
      }),
    );
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by,
        provider_resource_id, billing_mode, ready_at
      )
      values (
        ${managedId},
        ${`sbx_${managedId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        'e2b',
        'e2b',
        'ready',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${user.user.id},
        ${`fake-sbx_${managedId.replaceAll("-", "")}`},
        'managed',
        now()
      )
    `;
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by,
        provider_resource_id, billing_mode, ready_at
      )
      values (
        ${byokId},
        ${`sbx_${byokId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        'e2b',
        'e2b',
        'ready',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${user.user.id},
        ${`fake-sbx_${byokId.replaceAll("-", "")}`},
        'byok',
        now()
      )
    `;
    const [managedJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'sandbox.cost.sync',
        ${`sandbox:cost:${managedId}:down`},
        ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: managedId, final: false })}::jsonb,
        'pending'
      )
      returning id
    `;
    const [byokJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'sandbox.cost.sync',
        ${`sandbox:cost:${byokId}:byok`},
        ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: byokId, final: true })}::jsonb,
        'pending'
      )
      returning id
    `;
    const provider = new FakeSandboxProvider("e2b");
    provider.setCost(300_000n);
    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "billing-spend-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "8",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    await processUntilJob(
      String(managedJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
    );
    await processUntilJob(
      String(byokJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
    );
    const [byokUsage] = await database.sql`
      select provider_cost_microusd
      from metal.sandboxes
      where id = ${byokId}
    `;
    expect(Number(byokUsage?.provider_cost_microusd)).toBe(300_000);
    const [byokSnapshot] = await database.sql`
      select billing_mode, cost_delta_microusd
      from metal.provider_cost_snapshots
      where sandbox_id = ${byokId}
    `;
    expect(byokSnapshot?.billing_mode).toBe("byok");
    expect(Number(byokSnapshot?.cost_delta_microusd)).toBe(300_000);
    const [byokCharge] = await database.sql`
      select count(*)::int as count
      from metal.usage_charges
      where sandbox_id = ${byokId}
    `;
    expect(Number(byokCharge?.count)).toBe(0);
    const [afterCharge] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(Number(afterCharge?.balance_microusd)).toBe(100_000);
    provider.setCost(150_000n);
    const [correctionJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'sandbox.cost.sync',
        ${`sandbox:cost:${managedId}:correct`},
        ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: managedId, final: false })}::jsonb,
        'pending'
      )
      returning id
    `;
    await processUntilJob(
      String(correctionJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
    );
    const [afterCorrection] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(Number(afterCorrection?.balance_microusd)).toBe(250_000);

    const stripeGateway = new FakeStripeGateway();
    await database.sql`
      update metal.billing_accounts
      set stripe_customer_id = ${`cus_${orgId.replaceAll("-", "").slice(0, 16)}`},
          stripe_payment_method_id = 'pm_test_visa',
          payment_method_brand = 'visa',
          payment_method_last4 = '4242'
      where organization_id = ${orgId}
    `;
    await database.sql`
      insert into metal.auto_topup_policies (
        organization_id, enabled, status, threshold_microusd, refill_microusd, monthly_cap_microusd, updated_by
      )
      values (${orgId}, true, 'active', 300000, 5000000, 50000000, ${user.user.id})
      on conflict (organization_id) do update set
        enabled = true,
        status = 'active',
        threshold_microusd = 300000,
        refill_microusd = 5000000,
        monthly_cap_microusd = 50000000,
        paused_reason = null,
        updated_by = ${user.user.id}
    `;
    const [topupJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'billing.auto_topup.evaluate',
        ${`billing:auto-topup:${orgId}:test`},
        ${JSON.stringify({
          job_type: "billing.auto_topup.evaluate",
          organization_id: orgId,
          reason: "test",
        })}::jsonb,
        'pending'
      )
      returning id
    `;
    await processUntilJob(
      String(topupJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
      stripeGateway,
    );
    const intent = stripeGateway.paymentIntents.at(-1);
    expect(intent?.status).toBe("succeeded");
    const [afterTopup] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(Number(afterTopup?.balance_microusd)).toBe(5_250_000);
    await handleStripeWebhook(database.db, stripeGateway, {
      payload: JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "payment_intent.succeeded",
        data: { object: intent },
      }),
      signature: "test_signature",
      secret: "whsec_test",
    });
    const [afterWebhook] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(Number(afterWebhook?.balance_microusd)).toBe(5_250_000);

    await database.sql`
      update metal.auto_topup_policies
      set monthly_cap_microusd = 5000000,
          threshold_microusd = 10000000,
          status = 'active',
          paused_reason = null
      where organization_id = ${orgId}
    `;
    const [capJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'billing.auto_topup.evaluate',
        ${`billing:auto-topup:${orgId}:cap`},
        ${JSON.stringify({
          job_type: "billing.auto_topup.evaluate",
          organization_id: orgId,
          reason: "cap",
        })}::jsonb,
        'pending'
      )
      returning id
    `;
    await processUntilJob(
      String(capJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
      stripeGateway,
    );
    const [capped] = await database.sql`
      select status, paused_reason from metal.auto_topup_policies where organization_id = ${orgId}
    `;
    expect(capped).toMatchObject({ status: "paused", paused_reason: "monthly_cap" });
    await database.sql`
      update metal.auto_topup_policies
      set enabled = true,
          status = 'active',
          paused_reason = null,
          monthly_cap_microusd = 50000000,
          threshold_microusd = 300000
      where organization_id = ${orgId}
    `;

    stripeGateway.behavior.paymentIntentStatus = "requires_action";
    provider.setCost(5_400_000n);
    const [zeroJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'sandbox.cost.sync',
        ${`sandbox:cost:${managedId}:zero`},
        ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: managedId, final: false })}::jsonb,
        'pending'
      )
      returning id
    `;
    await processUntilJob(
      String(zeroJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
      stripeGateway,
    );
    const [failedTopup] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'billing.auto_topup.evaluate',
        ${`billing:auto-topup:${orgId}:zero`},
        ${JSON.stringify({
          job_type: "billing.auto_topup.evaluate",
          organization_id: orgId,
          reason: "zero",
        })}::jsonb,
        'pending'
      )
      returning id
    `;
    await processUntilJob(
      String(failedTopup!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
      stripeGateway,
    );
    const [policy] = await database.sql`
      select status, paused_reason from metal.auto_topup_policies where organization_id = ${orgId}
    `;
    expect(policy).toMatchObject({ status: "paused", paused_reason: "requires_action" });
    const [spendJob] = await database.sql`
      select id::text as id from metal.outbox_jobs
      where job_type = 'billing.spend_limit.enforce'
        and payload->>'organization_id' = ${orgId}
      order by created_at desc
      limit 1
    `;
    expect(spendJob?.id).toBeTruthy();
    await processUntilJob(
      String(spendJob!.id),
      { publish: async () => {} },
      workerEnv,
      (row) => row.status === "succeeded",
      { e2b: provider },
      stripeGateway,
    );
    const [managed] = await database.sql`
      select status from metal.sandboxes where id = ${managedId}
    `;
    const [byok] = await database.sql`
      select status from metal.sandboxes where id = ${byokId}
    `;
    expect(managed?.status).toBe("stopping");
    expect(byok?.status).toBe("ready");
  });

  it("fails automatic top up jobs when Stripe is not configured", async () => {
    const orgId = crypto.randomUUID();
    const [job] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'billing.auto_topup.evaluate',
        ${`billing:auto-topup:${orgId}:unconfigured`},
        ${JSON.stringify({
          job_type: "billing.auto_topup.evaluate",
          organization_id: orgId,
          reason: "unconfigured",
        })}::jsonb,
        'pending'
      )
      returning id
    `;
    const workerEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: "billing-unconfigured-stripe-worker",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "10",
      WORKER_MAX_ATTEMPTS: "8",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    await processOnce(database.db, { publish: async () => {} }, workerEnv, {}, null);
    const [row] = await database.sql`
      select status, last_error from metal.outbox_jobs where id = ${job!.id}
    `;
    expect(row?.status).toBe("pending");
    expect(String(row?.last_error)).toMatch(/stripe is not configured/i);
  });

  it("delivers signed webhooks with retries, dedupe, and disabled-endpoint filtering", async () => {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const orgId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Worker Webhook Org', ${`ww-${orgId.slice(0, 8)}`})
    `;

    type CapturedRequest = { headers: Record<string, string | string[] | undefined>; body: string };
    const captured: CapturedRequest[] = [];
    const responseQueue: number[] = [500, 200];
    const server: Server = createServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        captured.push({ headers: { ...request.headers }, body });
        response.statusCode = responseQueue.shift() ?? 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: response.statusCode === 200 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    try {
      const webhookSecret = `whsec_worker_${crypto.randomUUID().replaceAll("-", "")}`;
      const [endpoint] = await database.sql`
        with secret as (
          select vault.create_secret(
            ${webhookSecret},
            ${`metal:webhook:${orgId}:worker-test`},
            'Worker webhook test'
          ) as id
        )
        insert into metal.webhook_endpoints (
          organization_id, name, url, event_types, enabled, secret_id, secret_prefix, created_by
        )
        select ${orgId}, 'worker hook', ${`http://127.0.0.1:${port}/hook`}, '["project.created"]'::jsonb, true, secret.id, 'whsec_worker', ${user.user.id}
        from secret
        returning id
      `;
      const endpointId = String(endpoint!.id);

      const workerEnv = loadWorkerEnv({
        ...process.env,
        DATABASE_URL: env.DATABASE_URL,
        SUPABASE_URL: env.SUPABASE_URL,
        SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
        WORKER_ID: "webhook-delivery-worker",
        WORKER_LEASE_MS: "5000",
        WORKER_POLL_MS: "50",
        WORKER_BATCH_SIZE: "10",
        WORKER_MAX_ATTEMPTS: "8",
        WORKER_BASE_BACKOFF_MS: "10",
        WORKER_WEBHOOK_BASE_BACKOFF_MS: "100",
        LOG_LEVEL: "silent",
        METAL_ENVIRONMENT: "test",
      });
      const publisher = { publish: async () => {} };

      const { eventId, publicEvent } = await insertDomainEventAndBroadcast(database.db, {
        type: "project.created",
        organizationId: orgId,
        actorId: user.user.id,
        data: { name: "Webhook Project" },
      });

      const deliveries = await database.sql`
        select id, status, event_id from metal.webhook_deliveries where endpoint_id = ${endpointId}
      `;
      expect(deliveries).toHaveLength(1);
      const deliveryId = String(deliveries[0]!.id);

      for (let attempt = 0; attempt < 40; attempt += 1) {
        await processOnce(database.db, publisher, workerEnv, {}, null);
        const [current] = await database.sql`
          select status from metal.webhook_deliveries where id = ${deliveryId}
        `;
        if (current?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (attempt === 39) {
          throw new Error("webhook delivery did not succeed");
        }
      }

      expect(captured.length).toBeGreaterThanOrEqual(2);
      const success = captured.at(-1)!;
      expect(
        verifyWebhookSignature({
          secret: webhookSecret,
          deliveryId,
          rawBody: success.body,
          signatureHeader: String(success.headers["metal-signature"]),
          timestampHeader: String(success.headers["metal-signature-timestamp"]),
        }),
      ).toBe(true);
      expect(success.headers["metal-event-id"]).toBe(eventId);
      expect(success.headers["metal-event-type"]).toBe("project.created");
      expect(JSON.parse(success.body)).toMatchObject({
        event_id: eventId,
        type: "project.created",
      });

      const [final] = await database.sql`
        select status, attempt_count, last_http_status, delivered_at
        from metal.webhook_deliveries where id = ${deliveryId}
      `;
      expect(final).toMatchObject({
        status: "succeeded",
        last_http_status: 200,
      });
      expect(Number(final!.attempt_count)).toBe(2);
      expect(final!.delivered_at).toBeTruthy();

      const [job] = await database.sql`
        select status from metal.outbox_jobs
        where job_type = 'webhook.deliver' and payload->>'delivery_id' = ${deliveryId}
      `;
      expect(job?.status).toBe("succeeded");

      const duplicate = await enqueueWebhookDeliveries(database.db, {
        organizationId: orgId,
        eventId,
        publicEvent,
      });
      expect(duplicate).toBe(0);

      await database.sql`
        update metal.webhook_endpoints set enabled = false where id = ${endpointId}
      `;
      await insertDomainEventAndBroadcast(database.db, {
        type: "project.created",
        organizationId: orgId,
        actorId: user.user.id,
        data: { name: "Filtered Project" },
      });
      const afterDisable = await database.sql`
        select count(*)::int as count from metal.webhook_deliveries where endpoint_id = ${endpointId}
      `;
      expect(afterDisable[0]?.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
