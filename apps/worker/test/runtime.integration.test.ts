import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimOutboxJobs, createDatabase } from "@openmetal/db";
import { FakeSandboxProvider, loadTestEnv } from "@openmetal/testkit";
import { loadWorkerEnv } from "../src/env.js";
import { processOnce } from "../src/processor.js";

const testEnv = loadTestEnv();

describe("runtime worker", () => {
  const database = createDatabase({ DATABASE_URL: testEnv.DATABASE_URL });
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const sandboxId = crypto.randomUUID();
  const sandboxPublicId = `sbx_${sandboxId.replaceAll("-", "")}`;
  const provider = new FakeSandboxProvider("e2b", {
    exec: { output: [{ type: "stdout", data: Uint8Array.from([0, 255, 128, 65, 66, 67]) }] },
    now: new Date(),
  });
  const publisher = { publish: async () => undefined };
  const workerEnv = loadWorkerEnv({
    ...process.env,
    DATABASE_URL: testEnv.DATABASE_URL,
    SUPABASE_URL: testEnv.SUPABASE_URL,
    SUPABASE_SECRET_KEY: testEnv.SUPABASE_SECRET_KEY,
    WORKER_ID: `runtime-worker-${crypto.randomUUID()}`,
    WORKER_LEASE_MS: "5000",
    WORKER_POLL_MS: "50",
    WORKER_BATCH_SIZE: "100",
    WORKER_MAX_ATTEMPTS: "1",
    WORKER_BASE_BACKOFF_MS: "1",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });

  beforeAll(async () => {
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'Runtime Worker Org', ${`runtime-worker-${organizationId}`})
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId}, ${`prj_${projectId.replaceAll("-", "")}`}, ${organizationId},
        'Runtime Worker Project', ${`runtime-worker-${projectId}`}
      )
    `;
    const remote = await provider.create({
      metalSandboxId: sandboxPublicId,
      organizationId,
      projectId,
      language: "typescript",
      ttlMinutes: 30,
      source: { kind: "environment", environment: "metal/node", version: "1" },
      resources: { vcpu: 1, memoryMb: 2048, architecture: "x86_64" },
      lifecycle: {
        runtimeTimeoutSeconds: 1800,
        onRuntimeTimeout: "destroy",
        onIdleTimeout: "destroy",
      },
    });
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        provider_resource_id, provider_organization_id, status, source,
        resource_requirements, lifecycle, fallback, provider_options,
        environment, secret_refs, metadata, created_by
      )
      values (
        ${sandboxId}, ${sandboxPublicId}, ${organizationId}, ${projectId}, 'e2b', 'e2b',
        ${remote.providerResourceId}, ${remote.providerOrganizationId}, 'ready',
        '{"kind":"environment","environment":"metal/node","version":"1"}'::jsonb,
        '{"vcpu":1,"memory_mb":512,"architecture":"any"}'::jsonb,
        '{"runtime_timeout_seconds":300}'::jsonb, '{"providers":[]}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID()}
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
    throw new Error(`runtime job ${jobId} did not finish`);
  }

  it("persists bounded ordered output and ignores duplicate delivery", async () => {
    const processId = crypto.randomUUID();
    const [job] = await database.sql`
      with inserted_process as (
        insert into metal.sandbox_processes (
          id, organization_id, project_id, sandbox_id, command, max_output_bytes
        )
        values (
          ${processId}, ${organizationId}, ${projectId}, ${sandboxId}, '["binary"]'::jsonb, 5
        )
      ), inserted_event as (
        insert into metal.process_events (process_id, sequence, type)
        values (${processId}, 1, 'queued')
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'process.execute',
        ${`runtime-process-${processId}`},
        ${JSON.stringify({ job_type: "process.execute", process_id: processId })}::jsonb
      )
      returning id
    `;
    expect(await runUntil(String(job!.id))).toBe("succeeded");
    const [process] = await database.sql`
      select state, output_bytes, output_truncated, error
      from metal.sandbox_processes where id = ${processId}
    `;
    expect(process?.error).toBeNull();
    expect(process).toMatchObject({
      state: "succeeded",
      output_bytes: 5,
      output_truncated: true,
    });
    const events = await database.sql`
      select sequence, type, data from metal.process_events
      where process_id = ${processId}
      order by sequence
    `;
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[2]).toMatchObject({
      type: "stdout",
      data: { data_base64: "AP+AQUI=", byte_length: 5, stream_offset_bytes: 0 },
    });

    await database.sql`
      update metal.outbox_jobs
      set status = 'pending', available_at = now(), completed_at = null
      where id = ${String(job!.id)}
    `;
    expect(await runUntil(String(job!.id))).toBe("succeeded");
    const [afterDuplicate] = await database.sql`
      select count(*)::int as count from metal.process_events where process_id = ${processId}
    `;
    expect(afterDuplicate?.count).toBe(events.length);
  });

  it("roundtrips binary files and records unsupported capabilities safely", async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 128, 65]);
    const writeId = crypto.randomUUID();
    const [writeJob] = await database.sql`
      with operation as (
        insert into metal.runtime_operations (
          id, organization_id, project_id, sandbox_id, kind, request
        )
        values (
          ${writeId}, ${organizationId}, ${projectId}, ${sandboxId}, 'filesystem_write',
          ${JSON.stringify({
            path: "/tmp/binary",
            data_base64: bytes.toString("base64"),
            mode: "overwrite",
            create_parents: true,
          })}::jsonb
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'filesystem.write', ${`runtime-write-${writeId}`},
        ${JSON.stringify({ job_type: "filesystem.write", runtime_operation_id: writeId })}::jsonb
      )
      returning id
    `;
    expect(await runUntil(String(writeJob!.id))).toBe("succeeded");

    const readId = crypto.randomUUID();
    const [readJob] = await database.sql`
      with operation as (
        insert into metal.runtime_operations (
          id, organization_id, project_id, sandbox_id, kind, request
        )
        values (
          ${readId}, ${organizationId}, ${projectId}, ${sandboxId}, 'filesystem_read',
          '{"path":"/tmp/binary","offset_bytes":0,"limit_bytes":1024}'::jsonb
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'filesystem.read', ${`runtime-read-${readId}`},
        ${JSON.stringify({ job_type: "filesystem.read", runtime_operation_id: readId })}::jsonb
      )
      returning id
    `;
    expect(await runUntil(String(readJob!.id))).toBe("succeeded");
    const [read] = await database.sql`
      select state, result, error from metal.runtime_operations where id = ${readId}
    `;
    expect(read?.error).toBeNull();
    expect(read).toMatchObject({
      state: "succeeded",
      result: { kind: "filesystem_read", data_base64: bytes.toString("base64"), eof: true },
    });

    const unsupportedProvider = new FakeSandboxProvider("e2b", {
      unsupportedRuntimeOperations: ["deleteFile"],
    });
    unsupportedProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    const deleteId = crypto.randomUUID();
    const [deleteJob] = await database.sql`
      with operation as (
        insert into metal.runtime_operations (
          id, organization_id, project_id, sandbox_id, kind, request
        )
        values (
          ${deleteId}, ${organizationId}, ${projectId}, ${sandboxId}, 'filesystem_delete',
          '{"path":"/tmp/binary","recursive":false}'::jsonb
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'filesystem.delete', ${`runtime-delete-${deleteId}`},
        ${JSON.stringify({ job_type: "filesystem.delete", runtime_operation_id: deleteId })}::jsonb
      )
      returning id
    `;
    await processOnce(database.db, publisher, workerEnv, { e2b: unsupportedProvider });
    const [unsupported] = await database.sql`
      select state, error from metal.runtime_operations where id = ${deleteId}
    `;
    expect(unsupported).toMatchObject({
      state: "failed",
      error: { code: "capability_unsupported", retryable: false },
    });
    expect(await runUntil(String(deleteJob!.id))).toBe("succeeded");

    const granularProvider = new FakeSandboxProvider("e2b");
    granularProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    granularProvider.capabilities.runtime!.files!.writeModes = ["overwrite"];
    granularProvider.capabilities.runtime!.files!.createParents = false;
    let providerWriteCalls = 0;
    const originalWrite = granularProvider.writeFile.bind(granularProvider);
    granularProvider.writeFile = async (input) => {
      providerWriteCalls += 1;
      return originalWrite(input);
    };
    for (const [mode, createParents] of [
      ["append", false],
      ["overwrite", true],
    ] as const) {
      const unsupportedWriteId = crypto.randomUUID();
      const [unsupportedWriteJob] = await database.sql`
        with operation as (
          insert into metal.runtime_operations (
            id, organization_id, project_id, sandbox_id, kind, request
          )
          values (
            ${unsupportedWriteId}, ${organizationId}, ${projectId}, ${sandboxId},
            'filesystem_write',
            ${JSON.stringify({
              path: `/tmp/unsupported-${unsupportedWriteId}`,
              data_base64: "YQ==",
              mode,
              create_parents: createParents,
            })}::jsonb
          )
        )
        insert into metal.outbox_jobs (job_type, dedupe_key, payload)
        values (
          'filesystem.write', ${`runtime-write-unsupported-${unsupportedWriteId}`},
          ${JSON.stringify({
            job_type: "filesystem.write",
            runtime_operation_id: unsupportedWriteId,
          })}::jsonb
        )
        returning id
      `;
      expect(await runUntilWithProvider(String(unsupportedWriteJob!.id), granularProvider)).toBe(
        "succeeded",
      );
      const [unsupportedWrite] = await database.sql`
        select state, error from metal.runtime_operations where id = ${unsupportedWriteId}
      `;
      expect(unsupportedWrite).toMatchObject({
        state: "failed",
        error: { code: "capability_unsupported", retryable: false },
      });
    }
    expect(providerWriteCalls).toBe(0);
  });

  it("cancels queued processes and creates, revokes, and expires endpoints", async () => {
    const processId = crypto.randomUUID();
    const [cancelJob] = await database.sql`
      with process as (
        insert into metal.sandbox_processes (
          id, organization_id, project_id, sandbox_id, state, command, cancel_requested_at
        )
        values (
          ${processId}, ${organizationId}, ${projectId}, ${sandboxId},
          'cancelling', '["sleep","60"]'::jsonb, now()
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'process.cancel', ${`runtime-cancel-${processId}`},
        ${JSON.stringify({ job_type: "process.cancel", process_id: processId })}::jsonb
      )
      returning id
    `;
    expect(await runUntil(String(cancelJob!.id))).toBe("succeeded");
    const [cancelled] = await database.sql`
      select state from metal.sandbox_processes where id = ${processId}
    `;
    expect(cancelled?.state).toBe("cancelled");

    const endpointId = crypto.randomUUID();
    const [createJob] = await database.sql`
      with endpoint as (
        insert into metal.sandbox_endpoints (
          id, organization_id, project_id, sandbox_id, port, lease_expires_at
        )
        values (
          ${endpointId}, ${organizationId}, ${projectId}, ${sandboxId}, 8081,
          now() + interval '60 seconds'
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'endpoint.create', ${`runtime-endpoint-create-${endpointId}`},
        ${JSON.stringify({ job_type: "endpoint.create", endpoint_id: endpointId })}::jsonb
      )
      returning id
    `;
    const [recordedLease] = await database.sql`
      select lease_expires_at from metal.sandbox_endpoints where id = ${endpointId}
    `;
    expect(await runUntil(String(createJob!.id))).toBe("succeeded");
    const [active] = await database.sql`
      select state, url, lease_expires_at, provider_metadata, error
      from metal.sandbox_endpoints where id = ${endpointId}
    `;
    expect(active?.error).toBeNull();
    expect(active).toMatchObject({ state: "active" });
    expect(active?.lease_expires_at).toEqual(recordedLease?.lease_expires_at);
    expect(active?.provider_metadata).toMatchObject({
      lease_id: expect.any(String),
      lease_url: expect.any(String),
      lease_expires_at: expect.any(String),
    });
    expect(String(active?.url)).toContain(".fake.invalid:8081");

    await database.sql`
      update metal.sandbox_endpoints set state = 'revoking', revoked_at = now()
      where id = ${endpointId}
    `;
    const [revokeJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'endpoint.revoke', ${`runtime-endpoint-revoke-${endpointId}`},
        ${JSON.stringify({ job_type: "endpoint.revoke", endpoint_id: endpointId })}::jsonb
      )
      returning id
    `;
    expect(await runUntil(String(revokeJob!.id))).toBe("succeeded");
    const [revoked] = await database.sql`
      select state from metal.sandbox_endpoints where id = ${endpointId}
    `;
    expect(revoked?.state).toBe("revoked");
    expect([...provider.endpointLeases.values()].find((lease) => lease.revoked)?.revoked).toBe(
      true,
    );

    const expiredId = crypto.randomUUID();
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, organization_id, project_id, sandbox_id, port, state,
        lease_expires_at, created_at, provider_metadata
      )
      values (
        ${expiredId}, ${organizationId}, ${projectId}, ${sandboxId}, 8082, 'active',
        now() - interval '60 seconds', now() - interval '120 seconds', '{}'::jsonb
      )
    `;
    const foreignProjectId = crypto.randomUUID();
    const foreignSandboxId = crypto.randomUUID();
    const foreignSandboxPublicId = `sbx_${foreignSandboxId.replaceAll("-", "")}`;
    const foreignEndpointId = crypto.randomUUID();
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${foreignProjectId}, ${`prj_${foreignProjectId.replaceAll("-", "")}`},
        ${organizationId}, 'Foreign Expiry Project', ${`foreign-expiry-${foreignProjectId}`}
      )
    `;
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, regions, features, network,
        fallback, provider_options, environment, secret_refs, metadata, created_by
      )
      values (
        ${foreignSandboxId}, ${foreignSandboxPublicId}, ${organizationId}, ${foreignProjectId},
        'e2b', 'e2b', 'ready',
        '{"kind":"environment","environment":"metal/node","version":"1"}'::jsonb,
        '{"vcpu":1,"memory_mb":512,"architecture":"any"}'::jsonb,
        '{"runtime_timeout_seconds":300}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"providers":[]}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${crypto.randomUUID()}
      )
    `;
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, organization_id, project_id, sandbox_id, port, state,
        lease_expires_at, created_at, provider_metadata
      )
      values (
        ${foreignEndpointId}, ${organizationId}, ${foreignProjectId}, ${foreignSandboxId},
        8083, 'active', now() - interval '60 seconds', now() - interval '120 seconds',
        '{}'::jsonb
      )
    `;
    await processOnce(database.db, publisher, workerEnv, { e2b: provider });
    const [expired] = await database.sql`
      select state from metal.sandbox_endpoints where id = ${expiredId}
    `;
    expect(expired?.state).toBe("expired");
    const [expiredEvent] = await database.sql`
      select project_id, payload
      from metal.domain_events
      where type = 'endpoint.expired'
        and payload->>'endpoint_id' = (
          select public_id from metal.sandbox_endpoints where id = ${expiredId}
        )
      order by cursor desc
      limit 1
    `;
    expect(expiredEvent).toMatchObject({
      project_id: projectId,
      payload: {
        sandbox_id: sandboxPublicId,
        endpoint_id: expect.stringMatching(/^ep_/),
      },
    });
    const [foreignExpiredEvent] = await database.sql`
      select project_id, payload
      from metal.domain_events
      where type = 'endpoint.expired'
        and payload->>'endpoint_id' = (
          select public_id from metal.sandbox_endpoints where id = ${foreignEndpointId}
        )
      order by cursor desc
      limit 1
    `;
    expect(foreignExpiredEvent).toMatchObject({
      project_id: foreignProjectId,
      payload: {
        sandbox_id: foreignSandboxPublicId,
        endpoint_id: expect.stringMatching(/^ep_/),
      },
    });
  });

  it("fails closed after expired runtime leases are reclaimed", async () => {
    const processId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const endpointId = crypto.randomUUID();
    const oldToken = crypto.randomUUID();
    await database.sql`
      insert into metal.sandbox_processes (
        id, organization_id, project_id, sandbox_id, state, command, started_at, operation_token
      )
      values (
        ${processId}, ${organizationId}, ${projectId}, ${sandboxId}, 'running',
        '["reclaimed"]'::jsonb, now(), ${oldToken}
      )
    `;
    await database.sql`
      insert into metal.runtime_operations (
        id, organization_id, project_id, sandbox_id, kind, state, request, started_at,
        operation_token
      )
      values (
        ${operationId}, ${organizationId}, ${projectId}, ${sandboxId}, 'filesystem_write',
        'running', '{"path":"/tmp/reclaimed","data_base64":"YQ==","mode":"overwrite","create_parents":false}'::jsonb,
        now(), ${oldToken}
      )
    `;
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, organization_id, project_id, sandbox_id, port, state, lease_expires_at,
        operation_token
      )
      values (
        ${endpointId}, ${organizationId}, ${projectId}, ${sandboxId}, 18083,
        'provisioning', now() + interval '60 seconds', ${oldToken}
      )
    `;
    for (const [jobType, key, id] of [
      ["process.execute", "process_id", processId],
      ["filesystem.write", "runtime_operation_id", operationId],
      ["endpoint.create", "endpoint_id", endpointId],
    ]) {
      await database.sql`
        insert into metal.outbox_jobs (
          job_type, dedupe_key, payload, status, lease_owner, lease_token, lease_expires_at
        )
        values (
          ${jobType}, ${`reclaimed-${jobType}-${id}`},
          ${JSON.stringify({ job_type: jobType, [key]: id })}::jsonb,
          'leased', 'dead-runtime-worker', ${oldToken}, now() - interval '1 second'
        )
      `;
    }

    const reclaimedProvider = new FakeSandboxProvider("e2b", { now: new Date() });
    reclaimedProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    const durableEndpointLease = await reclaimedProvider.exposeHttpEndpoint!({
      providerResourceId: provider.resources.get(sandboxPublicId)!.providerResourceId,
      port: 18083,
      leaseDurationSeconds: 60,
    });
    await database.sql`
      update metal.sandbox_endpoints
      set provider_metadata = ${JSON.stringify({
        lease_id: durableEndpointLease.leaseId,
        lease_url: durableEndpointLease.url,
        lease_expires_at: durableEndpointLease.expiresAt.toISOString(),
      })}::jsonb
      where id = ${endpointId}
    `;
    let execCalls = 0;
    let writeCalls = 0;
    let exposeCalls = 0;
    let revokeCalls = 0;
    const originalExec = reclaimedProvider.exec.bind(reclaimedProvider);
    const originalWrite = reclaimedProvider.writeFile.bind(reclaimedProvider);
    const originalExpose = reclaimedProvider.exposeHttpEndpoint.bind(reclaimedProvider);
    const originalRevoke = reclaimedProvider.revokeHttpEndpoint.bind(reclaimedProvider);
    reclaimedProvider.exec = async (input) => {
      execCalls += 1;
      return originalExec(input);
    };
    reclaimedProvider.writeFile = async (input) => {
      writeCalls += 1;
      return originalWrite(input);
    };
    reclaimedProvider.exposeHttpEndpoint = async (input) => {
      exposeCalls += 1;
      return originalExpose(input);
    };
    reclaimedProvider.revokeHttpEndpoint = async (input) => {
      revokeCalls += 1;
      return originalRevoke(input);
    };

    await processOnce(
      database.db,
      publisher,
      { ...workerEnv, WORKER_ID: `reclaimer-${crypto.randomUUID()}` },
      { e2b: reclaimedProvider },
    );
    expect({ execCalls, writeCalls, exposeCalls, revokeCalls }).toEqual({
      execCalls: 0,
      writeCalls: 0,
      exposeCalls: 0,
      revokeCalls: 1,
    });
    const [states] = await database.sql`
      select
        (select state from metal.sandbox_processes where id = ${processId}) process_state,
        (select state from metal.runtime_operations where id = ${operationId}) operation_state,
        (select state from metal.sandbox_endpoints where id = ${endpointId}) endpoint_state,
        (select error from metal.sandbox_endpoints where id = ${endpointId}) endpoint_error
    `;
    expect(states).toMatchObject({
      process_state: "failed",
      operation_state: "failed",
      endpoint_state: "failed",
      endpoint_error: { code: "provider_unknown_outcome", retryable: false },
    });
    expect(reclaimedProvider.endpointLeases.get(durableEndpointLease.leaseId)).toMatchObject({
      revoked: true,
    });
  });

  it("renews a long runtime lease so another worker cannot reclaim it", async () => {
    const operationId = crypto.randomUUID();
    const [job] = await database.sql`
      with operation as (
        insert into metal.runtime_operations (
          id, organization_id, project_id, sandbox_id, kind, request
        )
        values (
          ${operationId}, ${organizationId}, ${projectId}, ${sandboxId}, 'filesystem_write',
          '{"path":"/tmp/heartbeat","data_base64":"YQ==","mode":"overwrite","create_parents":false}'::jsonb
        )
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'filesystem.write', ${`runtime-heartbeat-${operationId}`},
        ${JSON.stringify({
          job_type: "filesystem.write",
          runtime_operation_id: operationId,
        })}::jsonb
      )
      returning id
    `;
    await database.sql`
      update metal.outbox_jobs
      set created_at = case
        when id = ${String(job!.id)} then '1900-01-01T00:00:00Z'::timestamptz
        else now()
      end
      where status = 'pending'
    `;
    const delayedProvider = new FakeSandboxProvider("e2b");
    delayedProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    const originalWrite = delayedProvider.writeFile.bind(delayedProvider);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let notifyWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      notifyWrite = resolve;
    });
    delayedProvider.writeFile = async (input) => {
      notifyWrite();
      await writeGate;
      return originalWrite(input);
    };
    const processing = processOnce(
      database.db,
      publisher,
      {
        ...workerEnv,
        WORKER_ID: `heartbeat-${crypto.randomUUID()}`,
        WORKER_LEASE_MS: 1000,
        WORKER_BATCH_SIZE: 1,
      },
      { e2b: delayedProvider },
    );
    await writeStarted;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const reclaimed = await claimOutboxJobs(database.db, {
      workerId: `intruder-${crypto.randomUUID()}`,
      limit: 100,
      leaseMs: 5_000,
    });
    expect(reclaimed.some((candidate) => candidate.id === String(job!.id))).toBe(false);
    releaseWrite();
    await processing;
    const [completed] = await database.sql`
      select state from metal.runtime_operations where id = ${operationId}
    `;
    expect(completed?.state).toBe("succeeded");
  });

  it("retains active process events and cleans terminal processes by completion time", async () => {
    const terminalProcessId = crypto.randomUUID();
    const runningProcessId = crypto.randomUUID();
    await database.sql`
      insert into metal.sandbox_processes (
        id, organization_id, project_id, sandbox_id, command, state, created_at, completed_at
      )
      values
        (
          ${terminalProcessId}, ${organizationId}, ${projectId}, ${sandboxId},
          '["terminal-retention"]'::jsonb, 'succeeded',
          now() - interval '3 minutes', now() - interval '2 minutes'
        ),
        (
          ${runningProcessId}, ${organizationId}, ${projectId}, ${sandboxId},
          '["long-running"]'::jsonb, 'running',
          now() - interval '3 minutes', null
        )
    `;
    await database.sql`
      insert into metal.process_events (process_id, sequence, type, occurred_at)
      values
        (${terminalProcessId}, 1, 'queued', now() - interval '3 minutes'),
        (${terminalProcessId}, 2, 'exited', now()),
        (${runningProcessId}, 1, 'queued', now() - interval '3 minutes'),
        (${runningProcessId}, 2, 'started', now() - interval '2 minutes')
    `;
    await processOnce(
      database.db,
      publisher,
      {
        ...workerEnv,
        WORKER_ID: `retention-${crypto.randomUUID()}`,
        WORKER_PROCESS_EVENT_RETENTION_MS: 60_000,
      },
      { e2b: provider },
    );
    const terminalEvents = await database.sql`
      select sequence from metal.process_events
      where process_id = ${terminalProcessId}
      order by sequence
    `;
    const runningEvents = await database.sql`
      select sequence from metal.process_events
      where process_id = ${runningProcessId}
      order by sequence
    `;
    expect(terminalEvents).toEqual([]);
    expect(runningEvents.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("waits for a durable execution id before confirming cancellation", async () => {
    const processId = crypto.randomUUID();
    const [executeJob] = await database.sql`
      with process as (
        insert into metal.sandbox_processes (
          id, organization_id, project_id, sandbox_id, command, max_output_bytes
        )
        values (
          ${processId}, ${organizationId}, ${projectId}, ${sandboxId}, '["race"]'::jsonb, 1024
        )
      ), event as (
        insert into metal.process_events (process_id, sequence, type)
        values (${processId}, 1, 'queued')
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'process.execute', ${`cancel-race-execute-${processId}`},
        ${JSON.stringify({ job_type: "process.execute", process_id: processId })}::jsonb
      )
      returning id
    `;
    await database.sql`
      update metal.outbox_jobs
      set created_at = case
        when id = ${String(executeJob!.id)} then '1900-01-01T00:00:00Z'::timestamptz
        else now()
      end
      where status = 'pending'
    `;
    const raceProvider = new FakeSandboxProvider("e2b", { now: new Date() });
    raceProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    const originalExec = raceProvider.exec.bind(raceProvider);
    let releaseExec!: () => void;
    const execGate = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    let execStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      execStarted = resolve;
    });
    raceProvider.exec = async (input) => {
      execStarted();
      await execGate;
      return originalExec(input);
    };
    let cancelCalls = 0;
    const originalCancel = raceProvider.cancelExec.bind(raceProvider);
    raceProvider.cancelExec = async (input) => {
      cancelCalls += 1;
      if (cancelCalls === 1) {
        return { executionId: input.executionId, cancelled: false };
      }
      return originalCancel(input);
    };

    const executing = processOnce(
      database.db,
      publisher,
      {
        ...workerEnv,
        WORKER_ID: `execute-race-${crypto.randomUUID()}`,
        WORKER_BATCH_SIZE: 1,
      },
      { e2b: raceProvider },
    );
    await started;
    const [cancelJob] = await database.sql`
      with cancelled as (
        update metal.sandbox_processes
        set state = 'cancelling', cancel_requested_at = now()
        where id = ${processId}
      )
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'process.cancel', ${`cancel-race-cancel-${processId}`},
        ${JSON.stringify({ job_type: "process.cancel", process_id: processId })}::jsonb
      )
      returning id
    `;
    await database.sql`
      update metal.outbox_jobs
      set created_at = case
        when id = ${String(cancelJob!.id)} then '1900-01-01T00:00:00Z'::timestamptz
        else now()
      end
      where status = 'pending'
    `;
    await processOnce(
      database.db,
      publisher,
      {
        ...workerEnv,
        WORKER_ID: `cancel-race-${crypto.randomUUID()}`,
        WORKER_BATCH_SIZE: 1,
        WORKER_MAX_ATTEMPTS: 3,
      },
      { e2b: raceProvider },
    );
    const [waiting] = await database.sql`
      select state, provider_execution_id
      from metal.sandbox_processes where id = ${processId}
    `;
    expect(waiting).toMatchObject({ state: "cancelling", provider_execution_id: null });
    expect(cancelCalls).toBe(0);

    releaseExec();
    await executing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await processOnce(
      database.db,
      publisher,
      {
        ...workerEnv,
        WORKER_ID: `cancel-unconfirmed-${crypto.randomUUID()}`,
        WORKER_BATCH_SIZE: 1,
        WORKER_MAX_ATTEMPTS: 3,
      },
      { e2b: raceProvider },
    );
    const [unconfirmed] = await database.sql`
      select p.state, j.status
      from metal.sandbox_processes p
      join metal.outbox_jobs j on j.id = ${String(cancelJob!.id)}
      where p.id = ${processId}
    `;
    expect(unconfirmed).toMatchObject({ state: "cancelling", status: "pending" });
    expect(await runUntilWithProvider(String(cancelJob!.id), raceProvider)).toBe("succeeded");
    const [cancelled] = await database.sql`
      select state, provider_execution_id
      from metal.sandbox_processes where id = ${processId}
    `;
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.provider_execution_id).toBeTruthy();
    expect(cancelCalls).toBe(2);
    const [executeStatus] = await database.sql`
      select status from metal.outbox_jobs where id = ${String(executeJob!.id)}
    `;
    expect(executeStatus?.status).toBe("succeeded");
  });

  it("revokes endpoint orphans and rejects unconfirmed revocation", async () => {
    const orphanId = crypto.randomUUID();
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, organization_id, project_id, sandbox_id, port, lease_expires_at
      )
      values (
        ${orphanId}, ${organizationId}, ${projectId}, ${sandboxId}, 18084,
        now() + interval '60 seconds'
      )
    `;
    const orphanProvider = new FakeSandboxProvider("e2b", { now: new Date() });
    orphanProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    const originalExpose = orphanProvider.exposeHttpEndpoint.bind(orphanProvider);
    orphanProvider.exposeHttpEndpoint = async (input) => {
      const lease = await originalExpose(input);
      await database.sql`
        update metal.sandbox_endpoints set state = 'expired' where id = ${orphanId}
      `;
      return lease;
    };
    const [orphanJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'endpoint.create', ${`endpoint-orphan-${orphanId}`},
        ${JSON.stringify({ job_type: "endpoint.create", endpoint_id: orphanId })}::jsonb
      )
      returning id
    `;
    expect(await runUntilWithProvider(String(orphanJob!.id), orphanProvider)).toBe("succeeded");
    expect([...orphanProvider.endpointLeases.values()]).toEqual([
      expect.objectContaining({ revoked: true }),
    ]);
    const [orphan] = await database.sql`
      select state, url from metal.sandbox_endpoints where id = ${orphanId}
    `;
    expect(orphan).toMatchObject({ state: "expired", url: null });

    const overlongId = crypto.randomUUID();
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, organization_id, project_id, sandbox_id, port, lease_expires_at
      )
      values (
        ${overlongId}, ${organizationId}, ${projectId}, ${sandboxId}, 18086,
        now() + interval '60 seconds'
      )
    `;
    const overlongProvider = new FakeSandboxProvider("e2b", {
      now: new Date(Date.now() + 120_000),
    });
    overlongProvider.resources.set(sandboxPublicId, provider.resources.get(sandboxPublicId)!);
    const [overlongJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'endpoint.create', ${`endpoint-overlong-${overlongId}`},
        ${JSON.stringify({ job_type: "endpoint.create", endpoint_id: overlongId })}::jsonb
      )
      returning id
    `;
    expect(await runUntilWithProvider(String(overlongJob!.id), overlongProvider)).toBe("succeeded");
    const [overlong] = await database.sql`
      select state, error from metal.sandbox_endpoints where id = ${overlongId}
    `;
    expect(overlong).toMatchObject({
      state: "failed",
      error: { code: "provider_unknown_outcome" },
    });
    expect([...overlongProvider.endpointLeases.values()]).toEqual([
      expect.objectContaining({ revoked: true }),
    ]);

    const revokeId = crypto.randomUUID();
    const remoteLease = await orphanProvider.exposeHttpEndpoint({
      providerResourceId: provider.resources.get(sandboxPublicId)!.providerResourceId,
      port: 18085,
      leaseDurationSeconds: 30,
    });
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, organization_id, project_id, sandbox_id, port, state, lease_expires_at,
        provider_metadata, revoked_at
      )
      values (
        ${revokeId}, ${organizationId}, ${projectId}, ${sandboxId}, 18085, 'revoking',
        now() + interval '60 seconds',
        ${JSON.stringify({ lease_id: remoteLease.leaseId })}::jsonb, now()
      )
    `;
    orphanProvider.revokeHttpEndpoint = async (input) => ({
      leaseId: input.leaseId,
      revoked: false,
    });
    const [revokeJob] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'endpoint.revoke', ${`endpoint-unconfirmed-${revokeId}`},
        ${JSON.stringify({ job_type: "endpoint.revoke", endpoint_id: revokeId })}::jsonb
      )
      returning id
    `;
    expect(await runUntilWithProvider(String(revokeJob!.id), orphanProvider)).toBe("failed");
    const [unconfirmed] = await database.sql`
      select state, error from metal.sandbox_endpoints where id = ${revokeId}
    `;
    expect(unconfirmed).toMatchObject({
      state: "failed",
      error: { code: "endpoint_revoke_failed", retryable: true },
    });
  });

  async function runUntilWithProvider(jobId: string, runtimeProvider: FakeSandboxProvider) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await processOnce(database.db, publisher, workerEnv, { e2b: runtimeProvider });
      const [job] = await database.sql`
        select status from metal.outbox_jobs where id = ${jobId}
      `;
      if (job?.status === "succeeded" || job?.status === "failed") return job.status;
    }
    throw new Error(`runtime job ${jobId} did not finish`);
  }
});
