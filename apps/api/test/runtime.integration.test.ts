import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";
import { loadTestEnv } from "@openmetal/testkit";
import { buildApp } from "../src/app.js";
import { loadApiEnv } from "../src/env.js";

const testEnv = loadTestEnv();

describe("runtime API", () => {
  const database = createDatabase({ DATABASE_URL: testEnv.DATABASE_URL });
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const projectPublicId = `prj_${projectId.replaceAll("-", "")}`;
  const keyId = crypto.randomUUID();
  const apiKey = `metal_sk_${crypto.randomUUID().replaceAll("-", "")}`;
  const sandboxId = crypto.randomUUID();
  const sandboxPublicId = `sbx_${sandboxId.replaceAll("-", "")}`;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];

  const headers = {
    authorization: `Bearer ${apiKey}`,
    "x-metal-project-id": projectPublicId,
  };

  beforeAll(async () => {
    const env = loadApiEnv({
      ...process.env,
      DATABASE_URL: testEnv.DATABASE_URL,
      SUPABASE_URL: testEnv.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: testEnv.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: testEnv.SUPABASE_SECRET_KEY,
      METAL_SITE_URL: "http://localhost:3100",
      CORS_ALLOWED_ORIGINS: "http://localhost:3100",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    ({ app } = await buildApp(env, database));
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'Runtime API Org', ${`runtime-api-${organizationId}`})
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (${projectId}, ${projectPublicId}, ${organizationId}, 'Runtime API Project', ${`runtime-${projectId}`})
    `;
    await database.sql`
      insert into metal.project_api_keys (id, project_id, name, prefix, secret_hash, created_by)
      values (
        ${keyId},
        ${projectId},
        'runtime test',
        ${apiKey.slice(0, 20)},
        ${createHash("sha256").update(apiKey).digest("hex")},
        ${crypto.randomUUID()}
      )
    `;
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        provider_resource_id, status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by
      )
      values (
        ${sandboxId}, ${sandboxPublicId}, ${organizationId}, ${projectId}, 'e2b', 'e2b',
        ${`fake-${sandboxPublicId}`}, 'ready',
        '{"kind":"environment","environment":"metal/node","version":"1"}'::jsonb,
        '{"vcpu":1,"memory_mb":512,"architecture":"any"}'::jsonb,
        '{"runtime_timeout_seconds":300}'::jsonb, '{"providers":[]}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${keyId}
      )
    `;
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates, reads, resumes events, cancels, and isolates processes", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxPublicId}/processes`,
      headers: { ...headers, "idempotency-key": "process-1" },
      payload: { command: ["printf", "hello"], max_output_bytes: 1024 },
    });
    expect(created.statusCode).toBe(202);
    const process = created.json<{ id: string; state: string }>();
    expect(process).toMatchObject({ state: "queued" });

    await database.sql`
      insert into metal.process_events (process_id, sequence, type, data)
      select id, 2, 'started', '{}'::jsonb
      from metal.sandbox_processes
      where public_id = ${process.id}
    `;
    const events = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxPublicId}/processes/${process.id}/events`,
      headers: { ...headers, "last-event-id": "1" },
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).not.toContain("event: queued");
    expect(events.body).toContain("id: 2\nevent: started");

    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxPublicId}/processes/${process.id}/actions/cancel`,
      headers,
    });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json()).toMatchObject({ state: "cancelling" });

    const foreignProjectId = crypto.randomUUID();
    const foreignPublicId = `prj_${foreignProjectId.replaceAll("-", "")}`;
    const foreignKey = `metal_sk_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${foreignProjectId}, ${foreignPublicId}, ${organizationId},
        'Foreign Runtime Project', ${`foreign-${foreignProjectId}`}
      )
    `;
    await database.sql`
      insert into metal.project_api_keys (project_id, name, prefix, secret_hash, created_by)
      values (
        ${foreignProjectId}, 'foreign runtime test', ${foreignKey.slice(0, 20)},
        ${createHash("sha256").update(foreignKey).digest("hex")}, ${crypto.randomUUID()}
      )
    `;
    const isolated = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxPublicId}/processes/${process.id}`,
      headers: {
        authorization: `Bearer ${foreignKey}`,
        "x-metal-project-id": foreignPublicId,
      },
    });
    expect(isolated.statusCode).toBe(404);
  });

  it("bounds SSE batches and preserves Last-Event-ID pagination", async () => {
    const processId = crypto.randomUUID();
    const processPublicId = `proc_${processId.replaceAll("-", "")}`;
    await database.sql`
      insert into metal.sandbox_processes (
        id, public_id, organization_id, project_id, sandbox_id, command
      )
      values (
        ${processId}, ${processPublicId}, ${organizationId}, ${projectId}, ${sandboxId},
        '["many-events"]'::jsonb
      )
    `;
    await database.sql`
      insert into metal.process_events (process_id, sequence, type, data)
      select ${processId}, sequence, 'stdout',
        jsonb_build_object(
          'data_base64', 'YQ==',
          'byte_length', 1,
          'stream_offset_bytes', sequence - 1
        )
      from generate_series(1, 150) sequence
    `;

    const first = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxPublicId}/processes/${processPublicId}/events`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(1_048_576);
    expect(first.body.match(/^id: /gm)).toHaveLength(100);
    expect(first.body).toContain("id: 100\n");
    expect(first.body).not.toContain("id: 101\n");

    const second = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxPublicId}/processes/${processPublicId}/events`,
      headers: { ...headers, "last-event-id": "100" },
    });
    expect(second.body.match(/^id: /gm)).toHaveLength(50);
    expect(second.body).toContain("id: 101\n");
    expect(second.body).toContain("id: 150\n");
  });

  it("leaves endpoint expiry to the project-safe worker sweep", async () => {
    const endpointId = crypto.randomUUID();
    const endpointPublicId = `ep_${endpointId.replaceAll("-", "")}`;
    await database.sql`
      insert into metal.sandbox_endpoints (
        id, public_id, organization_id, project_id, sandbox_id, port, state,
        created_at, lease_expires_at
      )
      values (
        ${endpointId}, ${endpointPublicId}, ${organizationId}, ${projectId}, ${sandboxId},
        19090, 'active', now() - interval '2 minutes', now() - interval '1 minute'
      )
    `;
    const response = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxPublicId}/endpoints`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      endpoints: expect.arrayContaining([
        expect.objectContaining({ id: endpointPublicId, state: "active" }),
      ]),
    });
    const [stored] = await database.sql`
      select state,
        (select count(*)::int from metal.outbox_jobs
         where job_type = 'endpoint.revoke' and payload->>'endpoint_id' = ${endpointId}) as jobs
      from metal.sandbox_endpoints
      where id = ${endpointId}
    `;
    expect(stored).toMatchObject({ state: "active", jobs: 0 });
  });

  it("gates invalid state and accepts filesystem and endpoint operations", async () => {
    await database.sql`
      update metal.sandboxes set status = 'paused' where id = ${sandboxId}
    `;
    const invalidState = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxPublicId}/filesystem/read`,
      headers,
      payload: { path: "/tmp/value" },
    });
    expect(invalidState.statusCode).toBe(409);
    expect(invalidState.json()).toMatchObject({ code: "invalid_sandbox_state" });
    await database.sql`
      update metal.sandboxes set status = 'ready' where id = ${sandboxId}
    `;

    for (const [url, payload] of [
      [`/v1/sandboxes/${sandboxPublicId}/processes`, { command: ["missing-key"] }],
      [`/v1/sandboxes/${sandboxPublicId}/endpoints`, { port: 18080, lease_seconds: 60 }],
    ] as const) {
      const missingKey = await app.inject({ method: "POST", url, headers, payload });
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json()).toMatchObject({ code: "idempotency_key_required" });
    }

    const write = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxPublicId}/filesystem/write`,
      headers: { ...headers, "idempotency-key": "write-1" },
      payload: { path: "/tmp/binary", data_base64: "AP+AQQ==" },
    });
    expect(write.statusCode).toBe(202);
    expect(write.json()).toMatchObject({ kind: "filesystem_write", state: "queued" });

    const endpoint = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxPublicId}/endpoints`,
      headers: { ...headers, "idempotency-key": "endpoint-1" },
      payload: { port: 8080, lease_seconds: 60 },
    });
    expect(endpoint.statusCode).toBe(202);
    const endpointBody = endpoint.json<{ id: string }>();
    const listed = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxPublicId}/endpoints`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ endpoints: Array<{ id: string }> }>().endpoints).toContainEqual(
      expect.objectContaining({ id: endpointBody.id }),
    );

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/sandboxes/${sandboxPublicId}/endpoints/${endpointBody.id}`,
      headers,
    });
    expect(revoked.statusCode).toBe(202);
    expect(revoked.json()).toMatchObject({ state: "revoking" });

    const maxLease = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxPublicId}/endpoints`,
      headers: { ...headers, "idempotency-key": "endpoint-max-lease" },
      payload: { port: 8081, lease_seconds: 86_400 },
    });
    expect(maxLease.statusCode).toBe(202);
    const [storedMaxLease] = await database.sql`
      select extract(epoch from (lease_expires_at - created_at))::int as lease_seconds
      from metal.sandbox_endpoints
      where public_id = ${maxLease.json<{ id: string }>().id}
    `;
    expect(storedMaxLease?.lease_seconds).toBe(86_400);
  });
});
