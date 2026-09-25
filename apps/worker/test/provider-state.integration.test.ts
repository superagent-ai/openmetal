import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";
import { FakeSandboxProvider, loadTestEnv } from "@openmetal/testkit";
import { loadWorkerEnv } from "../src/env.js";
import { processOnce } from "../src/processor.js";

const testEnv = loadTestEnv();

describe("provider-side sandbox state reconciliation", () => {
  const database = createDatabase({ DATABASE_URL: testEnv.DATABASE_URL });
  const publisher = { publish: async () => undefined };
  const workerEnv = loadWorkerEnv({
    ...process.env,
    DATABASE_URL: testEnv.DATABASE_URL,
    SUPABASE_URL: testEnv.SUPABASE_URL,
    SUPABASE_SECRET_KEY: testEnv.SUPABASE_SECRET_KEY,
    WORKER_ID: `provider-state-worker-${crypto.randomUUID()}`,
    WORKER_LEASE_MS: "5000",
    WORKER_POLL_MS: "50",
    WORKER_BATCH_SIZE: "100",
    WORKER_MAX_ATTEMPTS: "1",
    WORKER_BASE_BACKOFF_MS: "1",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });
  let provider: FakeSandboxProvider;
  let organizationId: string;
  let projectId: string;
  let sandboxId: string;
  let sandboxPublicId: string;
  let providerResourceId: string;

  beforeEach(async () => {
    provider = new FakeSandboxProvider("e2b", { reportsSandboxState: true, now: new Date() });
    organizationId = crypto.randomUUID();
    projectId = crypto.randomUUID();
    sandboxId = crypto.randomUUID();
    sandboxPublicId = `sbx_${sandboxId.replaceAll("-", "")}`;
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'Provider State Org', ${`provider-state-${organizationId}`})
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId}, ${`prj_${projectId.replaceAll("-", "")}`}, ${organizationId},
        'Provider State Project', ${`provider-state-${projectId}`}
      )
    `;
    const remote = await provider.create({
      metalSandboxId: sandboxPublicId,
      organizationId,
      projectId,
      language: "typescript",
      ttlMinutes: 240,
      source: { kind: "environment", environment: "metal/node", version: "1" },
      resources: { vcpu: 1, memoryMb: 2048, architecture: "x86_64" },
      lifecycle: {
        runtimeTimeoutSeconds: 14_400,
        onRuntimeTimeout: "destroy",
        onIdleTimeout: "destroy",
      },
    });
    providerResourceId = remote.providerResourceId;
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        provider_resource_id, provider_organization_id, status, source,
        resource_requirements, lifecycle, fallback, provider_options,
        environment, secret_refs, metadata, created_by, ready_at
      )
      values (
        ${sandboxId}, ${sandboxPublicId}, ${organizationId}, ${projectId}, 'e2b', 'e2b',
        ${remote.providerResourceId}, ${remote.providerOrganizationId}, 'ready',
        '{"kind":"environment","environment":"metal/node","version":"1"}'::jsonb,
        '{"vcpu":1,"memory_mb":2048,"architecture":"any"}'::jsonb,
        '{"runtime_timeout_seconds":14400}'::jsonb, '{"providers":[]}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID()}, now()
      )
    `;
    await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, available_at)
      values (
        'sandbox.destroy', ${`sandbox:destroy:${sandboxId}`},
        ${JSON.stringify({ job_type: "sandbox.destroy", sandbox_id: sandboxId })}::jsonb,
        now() + interval '4 hours'
      )
    `;
  });

  afterAll(async () => {
    await database.shutdown();
  });

  async function runUntil(jobId: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await processOnce(database.db, publisher, workerEnv, { e2b: provider });
      const [job] = await database.sql`
        select status from metal.outbox_jobs where id = ${jobId}
      `;
      if (job?.status === "succeeded" || job?.status === "failed") return job.status;
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  async function queueProcess() {
    const processId = crypto.randomUUID();
    const [job] = await database.sql`
      with inserted_process as (
        insert into metal.sandbox_processes (
          id, organization_id, project_id, sandbox_id, command, max_output_bytes
        )
        values (
          ${processId}, ${organizationId}, ${projectId}, ${sandboxId},
          '["sh","-lc","tail -f scanner.log"]'::jsonb, 1024
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'process.execute', ${`provider-state-process-${processId}`},
        ${JSON.stringify({ job_type: "process.execute", process_id: processId })}::jsonb
      )
      returning id
    `;
    return { processId, jobId: String(job!.id) };
  }

  async function queueFileRead(path: string) {
    const operationId = crypto.randomUUID();
    const [job] = await database.sql`
      with inserted_operation as (
        insert into metal.runtime_operations (
          id, organization_id, project_id, sandbox_id, kind, request
        )
        values (
          ${operationId}, ${organizationId}, ${projectId}, ${sandboxId}, 'filesystem_read',
          ${JSON.stringify({ path, offset_bytes: 0, limit_bytes: 1024 })}::jsonb
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'filesystem.read', ${`provider-state-read-${operationId}`},
        ${JSON.stringify({ job_type: "filesystem.read", runtime_operation_id: operationId })}::jsonb
      )
      returning id
    `;
    return { operationId, jobId: String(job!.id) };
  }

  async function sandboxRow() {
    const [row] = await database.sql`
      select status, error_code, error_message, deleted_at
      from metal.sandboxes where id = ${sandboxId}
    `;
    return row;
  }

  async function destroyJob() {
    const [job] = await database.sql`
      select id, status, attempt_count, available_at <= now() as due
      from metal.outbox_jobs where dedupe_key = ${`sandbox:destroy:${sandboxId}`}
    `;
    return job;
  }

  it("stops a ready sandbox the provider removed and reports the provider failure", async () => {
    await provider.destroy(providerResourceId);

    const execution = await queueProcess();
    expect(await runUntil(execution.jobId)).toBe("succeeded");
    const [process] = await database.sql`
      select state, error from metal.sandbox_processes where id = ${execution.processId}
    `;
    expect(process).toMatchObject({
      state: "failed",
      error: {
        code: "process_failed",
        message: "fake sandbox is not running",
        retryable: false,
      },
    });
    expect(await sandboxRow()).toMatchObject({
      status: "stopping",
      error_code: "provider_stopped",
      error_message: "e2b no longer has this sandbox",
    });
    expect(await destroyJob()).toMatchObject({ status: "pending", attempt_count: 0, due: true });

    const destroy = await destroyJob();
    expect(await runUntil(String(destroy!.id))).toBe("succeeded");
    const stopped = await sandboxRow();
    expect(stopped).toMatchObject({
      status: "stopped",
      error_code: "provider_stopped",
      error_message: "e2b no longer has this sandbox",
    });
    expect(stopped?.deleted_at).not.toBeNull();
    const [deletedEvent] = await database.sql`
      select payload from metal.domain_events
      where type = 'sandbox.deleted' and payload->>'sandbox_id' = ${sandboxPublicId}
    `;
    expect(deletedEvent?.payload).toMatchObject({
      sandbox_id: sandboxPublicId,
      provider: "e2b",
      reason: "provider_stopped",
    });
    const [finalCostSync] = await database.sql`
      select count(*)::int as count from metal.outbox_jobs
      where job_type = 'sandbox.cost.sync'
        and payload->>'sandbox_id' = ${sandboxId}
        and payload->>'final' = 'true'
    `;
    expect(finalCostSync?.count).toBe(1);

    const read = await queueFileRead("/workspace/scanner.log");
    expect(await runUntil(read.jobId)).toBe("succeeded");
    const [operation] = await database.sql`
      select state, error from metal.runtime_operations where id = ${read.operationId}
    `;
    expect(operation).toMatchObject({
      state: "failed",
      error: {
        code: "runtime_operation_failed",
        message: "sandbox is not ready (stopped: provider_stopped)",
      },
    });
  });

  it("keeps a running sandbox ready after a customer runtime failure", async () => {
    const read = await queueFileRead("/workspace/missing.txt");
    expect(await runUntil(read.jobId)).toBe("succeeded");
    const [operation] = await database.sql`
      select state, error from metal.runtime_operations where id = ${read.operationId}
    `;
    expect(operation).toMatchObject({
      state: "failed",
      error: { code: "runtime_operation_failed", message: "fake file not found" },
    });
    expect(await sandboxRow()).toMatchObject({ status: "ready", error_code: null });
    expect(await destroyJob()).toMatchObject({ status: "pending", due: false });
  });

  it("detects a provider-side stop during routine cost sync", async () => {
    provider.setCost(0n);
    const [costSync] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'sandbox.cost.sync', ${`provider-state-cost-${sandboxId}`},
        ${JSON.stringify({ job_type: "sandbox.cost.sync", sandbox_id: sandboxId, final: false })}::jsonb
      )
      returning id
    `;
    expect(await runUntil(String(costSync!.id))).toBe("succeeded");
    expect(await sandboxRow()).toMatchObject({ status: "ready", error_code: null });

    await provider.destroy(providerResourceId);
    const [nextSync] = await database.sql`
      update metal.outbox_jobs
      set available_at = now()
      where job_type = 'sandbox.cost.sync'
        and status = 'pending'
        and payload->>'sandbox_id' = ${sandboxId}
      returning id
    `;
    expect(await runUntil(String(nextSync!.id))).toBe("succeeded");
    expect(await sandboxRow()).toMatchObject({
      status: "stopping",
      error_code: "provider_stopped",
    });
    expect(await destroyJob()).toMatchObject({ status: "pending", due: true });
  });
});
