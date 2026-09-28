import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCredits } from "@openmetal/billing";
import { createDatabase, withTransaction } from "@openmetal/db";
import { GpuTypeCatalogResponseSchema } from "@openmetal/contracts";
import { createConfirmedUser, deleteUser, loadTestEnv } from "@openmetal/testkit";
import { MetalClient } from "@openmetal/sdk";
import { buildApp } from "../src/app.js";
import { loadApiEnv } from "../src/env.js";

const env = loadTestEnv();

describe("GPU jobs API", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  let appUrl = "";
  let close = async () => {};
  const users: string[] = [];

  beforeAll(async () => {
    const apiEnv = loadApiEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      METAL_SITE_URL: "http://localhost:3100",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3100",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    const { app } = await buildApp(apiEnv, database, { stripe: null });
    appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
  });

  afterAll(async () => {
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await close();
  });

  async function projectClient(options: { credits?: bigint } = {}) {
    const owner = await createConfirmedUser(env);
    users.push(owner.user.id);
    const userClient = new MetalClient({ baseUrl: appUrl, accessToken: () => owner.accessToken });
    const organization = await userClient.organizations.create({
      name: "GPU Org",
      slug: `gpu-${crypto.randomUUID().slice(0, 8)}`,
    });
    const project = await userClient.projects.create(organization.id, {
      name: "GPU Project",
      slug: `gpu-project-${crypto.randomUUID().slice(0, 8)}`,
    });
    await database.sql`
      update metal.billing_accounts set balance_microusd = 0
      where organization_id = ${organization.id}
    `;
    if (options.credits) {
      await withTransaction(database.db, (tx) =>
        grantCredits(tx, {
          organizationId: organization.id,
          creditMicrousd: options.credits!,
          actorId: owner.user.id,
        }),
      );
    }
    const key = await userClient.apiKeys.create(project.id, { name: "gpu key", expires_in: null });
    const client = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => key.key,
      projectId: project.id,
      retry: { attempts: 1 },
    });
    return { client, userClient, organization, project, owner, apiKey: key.key };
  }

  const baseRequest = {
    source: {
      kind: "oci_image" as const,
      image: "pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime",
      command: ["python", "-c", "print('hello')"],
    },
    gpu: { type: "nvidia-h100" as const, count: 1 },
    lifecycle: { max_runtime_seconds: 600 },
  };

  it("publishes the GPU catalog with per-second rates", async () => {
    const response = await fetch(`${appUrl}/v1/gpu/types`);
    expect(response.status).toBe(200);
    const catalog = GpuTypeCatalogResponseSchema.parse(await response.json());
    const h100 = catalog.gpu_types.find((type) => type.id === "nvidia-h100");
    expect(h100).toMatchObject({ vram_gb: 80 });
    expect(h100?.offers).toEqual([
      expect.objectContaining({
        provider: "modal",
        provider_gpu: "H100",
        max_count: 8,
        price_per_gpu_hour_usd: "3.949200",
        billing_granularity: "per_second",
      }),
    ]);
    expect(catalog.gpu_types.map((type) => type.id)).toHaveLength(11);
    expect(h100?.offers[0]?.region_price_multipliers).toEqual({ broad: "1.15", narrow: "1.75" });
    expect(catalog.regions).toEqual(
      expect.arrayContaining([
        { id: "us", name: "United States", scope: "broad" },
        { id: "us-west", name: "US West", scope: "narrow" },
      ]),
    );
  });

  it("creates GPU jobs idempotently without echoing secrets", async () => {
    const { client, apiKey, project, organization } = await projectClient({
      credits: 50_000_000n,
    });
    const request = {
      ...baseRequest,
      environment: { EPOCHS: "3" },
      secrets: { HF_TOKEN: "hf_super_secret_value" },
      limits: { max_cost_usd: "2.50" },
      metadata: { run: "r-1" },
    };

    const raw = await fetch(`${appUrl}/v1/gpu/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "gpu-create-1",
        "x-metal-project-id": project.id,
      },
      body: JSON.stringify(request),
    });
    expect(raw.status).toBe(202);
    const text = await raw.text();
    expect(text).not.toContain("hf_super_secret_value");
    const first = JSON.parse(text) as {
      gpu_job: { id: string; state: string; requested: Record<string, unknown> };
      operation: { id: string; resource_type: string; resource_id: string; type: string };
    };
    expect(raw.headers.get("location")).toBe(`/v1/operations/${first.operation.id}`);
    expect(first.gpu_job.id).toMatch(/^gpj_/);
    expect(first.gpu_job.state).toBe("requested");
    expect(first.gpu_job.requested).toMatchObject({
      provider: "auto",
      gpu: { type: "nvidia-h100", count: 1 },
      environment: { EPOCHS: "3" },
      secret_names: ["HF_TOKEN"],
      limits: { max_cost_usd: "2.50" },
    });
    expect(first.operation).toMatchObject({
      type: "gpu_job_create",
      resource_type: "gpu_job",
      resource_id: first.gpu_job.id,
    });

    const replay = await client.gpuJobs.createAsync(request, { idempotencyKey: "gpu-create-1" });
    expect(replay.gpu_job.id).toBe(first.gpu_job.id);
    await expect(
      client.gpuJobs.createAsync(
        { ...request, metadata: { run: "r-2" } },
        { idempotencyKey: "gpu-create-1" },
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_mismatch" });

    const [row] = await database.sql`
      select jobs.id, jobs.secrets_vault_id, jobs.max_cost_microusd::text as max_cost,
        secrets.decrypted_secret
      from metal.gpu_jobs jobs
      left join vault.decrypted_secrets secrets on secrets.id = jobs.secrets_vault_id
      where jobs.public_id = ${first.gpu_job.id}
    `;
    expect(row?.max_cost).toBe("2500000");
    expect(JSON.parse(String(row?.decrypted_secret))).toEqual({
      version: 2,
      environment: { HF_TOKEN: "hf_super_secret_value" },
      registry: null,
      mounts: [],
    });
    const [submit] = await database.sql`
      select payload, lock_key, lock_mode from metal.outbox_jobs
      where dedupe_key = ${`gpu_job:submit:${row?.id}`}
    `;
    expect(submit).toMatchObject({
      lock_key: `gpu_job:${row?.id}`,
      lock_mode: "exclusive",
    });

    const operation = await client.operations.get(first.operation.id);
    expect(operation).toMatchObject({ resource_type: "gpu_job", resource_id: first.gpu_job.id });
    const [requested] = await database.sql`
      select payload from metal.domain_events
      where organization_id = ${organization.id} and type = 'gpu_job.requested'
    `;
    expect(requested?.payload).toMatchObject({
      gpu_job_id: first.gpu_job.id,
      gpu_type: "nvidia-h100",
      gpu_count: 1,
    });
    expect(JSON.stringify(requested?.payload)).not.toContain("hf_super_secret_value");
  });

  it("prices region-pinned jobs and never echoes registry or bucket credentials", async () => {
    const { client } = await projectClient({ credits: 50_000_000n });
    const created = await client.gpuJobs.createAsync({
      ...baseRequest,
      source: {
        ...baseRequest.source,
        image: "ghcr.io/acme/trainer:1",
        registry_auth: { kind: "basic", username: "bot", password: "registry-password-value" },
      },
      placement: { regions: ["us-west", "us-east"] },
      resources: { vcpu: 8, memory_mb: 32_768 },
      lifecycle: { max_runtime_seconds: 600, max_start_seconds: 300 },
      mounts: [
        {
          kind: "bucket",
          provider: "s3",
          bucket: "acme-outputs",
          mount_path: "/outputs",
          key_prefix: "runs/1/",
          region: "us-east-1",
          credentials: { access_key_id: "AKIAEXAMPLE", secret_access_key: "bucket-secret-value" },
        },
      ],
    });
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain("registry-password-value");
    expect(serialized).not.toContain("bucket-secret-value");
    expect(serialized).not.toContain("AKIAEXAMPLE");
    expect(created.gpu_job.requested).toMatchObject({
      source: { image: "ghcr.io/acme/trainer:1", registry_auth: { kind: "basic" } },
      placement: { regions: ["us-west", "us-east"] },
      lifecycle: { max_runtime_seconds: 600, max_start_seconds: 300 },
      mounts: [
        {
          kind: "bucket",
          provider: "s3",
          bucket: "acme-outputs",
          mount_path: "/outputs",
          key_prefix: "runs/1/",
          read_only: false,
        },
      ],
    });
    // H100 $3.9492 + 4 cores * $0.141912 + 32 GiB * $0.024012, times 1.75 for narrow regions.
    expect(created.gpu_job.pricing).toEqual({
      price_multiplier: "1.75",
      estimated_hourly_cost_usd: "9.249156",
      rate_card_version: "modal-2026-09-27",
    });
    const [row] = await database.sql`
      select secrets.decrypted_secret, jobs.source, jobs.mounts
      from metal.gpu_jobs jobs
      join vault.decrypted_secrets secrets on secrets.id = jobs.secrets_vault_id
      where jobs.public_id = ${created.gpu_job.id}
    `;
    expect(JSON.parse(String(row?.decrypted_secret))).toEqual({
      version: 2,
      environment: {},
      registry: { kind: "basic", username: "bot", password: "registry-password-value" },
      mounts: [{ access_key_id: "AKIAEXAMPLE", secret_access_key: "bucket-secret-value" }],
    });
    expect(JSON.stringify(row?.source)).not.toContain("registry-password-value");
    expect(JSON.stringify(row?.mounts)).not.toContain("bucket-secret-value");

    const broad = await client.gpuJobs.createAsync({
      ...baseRequest,
      placement: { regions: ["eu", "eu-west"] },
    });
    expect(broad.gpu_job.pricing.price_multiplier).toBe("1.15");
    const unpinned = await client.gpuJobs.createAsync(baseRequest);
    expect(unpinned.gpu_job.pricing.price_multiplier).toBe("1.00");
    expect(unpinned.gpu_job.requested.lifecycle.max_start_seconds).toBe(1_800);
  });

  it("lists, paginates, filters, and isolates GPU jobs by project", async () => {
    const { client } = await projectClient({ credits: 50_000_000n });
    const { client: otherClient } = await projectClient({ credits: 50_000_000n });
    const first = await client.gpuJobs.createAsync(baseRequest);
    const second = await client.gpuJobs.createAsync({
      ...baseRequest,
      gpu: { type: "nvidia-t4", count: 2 },
    });

    const page = await client.gpuJobs.list({ limit: 1 });
    expect(page.gpu_jobs.map((job) => job.id)).toEqual([second.gpu_job.id]);
    expect(page.next_cursor).toBe(second.gpu_job.id);
    const next = await client.gpuJobs.list({ limit: 1, cursor: page.next_cursor! });
    expect(next.gpu_jobs.map((job) => job.id)).toEqual([first.gpu_job.id]);
    expect(next.next_cursor).toBeNull();
    const filtered = await client.gpuJobs.list({ state: "cancelled" });
    expect(filtered.gpu_jobs).toEqual([]);

    await expect(otherClient.gpuJobs.get(first.gpu_job.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(otherClient.gpuJobs.cancelAsync(first.gpu_job.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("cancels an unsubmitted job immediately and purges its secrets", async () => {
    const { client } = await projectClient({ credits: 50_000_000n });
    const created = await client.gpuJobs.createAsync({
      ...baseRequest,
      secrets: { API_TOKEN: "token-value" },
    });
    const [before] = await database.sql`
      select secrets_vault_id from metal.gpu_jobs where public_id = ${created.gpu_job.id}
    `;
    expect(before?.secrets_vault_id).toBeTruthy();

    const cancelled = await client.gpuJobs.cancelAsync(created.gpu_job.id);
    expect(cancelled.gpu_job).toMatchObject({
      state: "cancelled",
      state_reason: "cancelled_by_user",
      logs_complete: true,
    });
    expect(cancelled.gpu_job.finished_at).not.toBeNull();
    expect(cancelled.operation).toMatchObject({ type: "gpu_job_cancel", state: "succeeded" });
    await expect(client.operations.get(created.operation.id)).resolves.toMatchObject({
      state: "cancelled",
    });

    const [after] = await database.sql`
      select secrets_vault_id from metal.gpu_jobs where public_id = ${created.gpu_job.id}
    `;
    expect(after?.secrets_vault_id).toBeNull();
    const [vault] = await database.sql`
      select count(*)::int as count from vault.secrets where id = ${String(before?.secrets_vault_id)}
    `;
    expect(vault?.count).toBe(0);

    await expect(client.gpuJobs.cancelAsync(created.gpu_job.id)).rejects.toMatchObject({
      status: 409,
      code: "gpu_job_terminal",
    });
  });

  it("marks a running job cancelling and queues provider termination", async () => {
    const { client } = await projectClient({ credits: 50_000_000n });
    const created = await client.gpuJobs.createAsync(baseRequest);
    await database.sql`
      update metal.gpu_jobs
      set state = 'running', provider = 'modal', provider_resource_id = ${`sb-${crypto.randomUUID()}`},
        started_at = now()
      where public_id = ${created.gpu_job.id}
    `;

    const cancelling = await client.gpuJobs.cancelAsync(created.gpu_job.id);
    expect(cancelling.gpu_job).toMatchObject({ state: "cancelling" });
    expect(cancelling.gpu_job.cancel_requested_at).not.toBeNull();
    expect(cancelling.operation).toMatchObject({ type: "gpu_job_cancel", state: "queued" });
    const [job] = await database.sql`
      select id from metal.gpu_jobs where public_id = ${created.gpu_job.id}
    `;
    const [cancel] = await database.sql`
      select payload from metal.outbox_jobs where dedupe_key = ${`gpu_job:cancel:${job?.id}`}
    `;
    expect(cancel?.payload).toMatchObject({
      job_type: "gpu_job.cancel",
      reason: "cancelled_by_user",
    });
  });

  it("rejects unsupported and unsafe requests before provisioning", async () => {
    const { project, apiKey } = await projectClient({ credits: 50_000_000n });
    const cases: Array<[unknown, number, string]> = [
      [{ ...baseRequest, gpu: { type: "nvidia-a10", count: 5 } }, 422, "capability_unsupported"],
      [{ ...baseRequest, gpu: { type: "nvidia-h100", count: 9 } }, 422, "validation_error"],
      [{ ...baseRequest, gpu: { type: "nvidia-v100", count: 1 } }, 422, "validation_error"],
      [{ ...baseRequest, lifecycle: { max_runtime_seconds: 90_000 } }, 422, "validation_error"],
      [
        { ...baseRequest, environment: { TOKEN: "a" }, secrets: { TOKEN: "b" } },
        422,
        "validation_error",
      ],
      [{ ...baseRequest, source: { ...baseRequest.source, command: [] } }, 422, "validation_error"],
      [
        {
          ...baseRequest,
          provider_options: {
            modal: { volumes: [{ name: "checkpoints", mount_path: "/checkpoints" }] },
          },
        },
        422,
        "capability_unsupported",
      ],
      [{ ...baseRequest, placement: { regions: ["mars"] } }, 422, "validation_error"],
      [{ ...baseRequest, placement: { regions: ["us", "us"] } }, 422, "validation_error"],
      [
        {
          ...baseRequest,
          mounts: [
            {
              kind: "bucket",
              provider: "r2",
              bucket: "outputs",
              mount_path: "/outputs",
              credentials: { access_key_id: "a", secret_access_key: "b" },
            },
          ],
        },
        422,
        "validation_error",
      ],
      [
        {
          ...baseRequest,
          mounts: [
            {
              kind: "bucket",
              provider: "s3",
              bucket: "outputs",
              mount_path: "/outputs",
              key_prefix: "no-trailing-slash",
              credentials: { access_key_id: "a", secret_access_key: "b" },
            },
          ],
        },
        422,
        "validation_error",
      ],
      [
        {
          ...baseRequest,
          source: {
            ...baseRequest.source,
            registry_auth: { kind: "aws_ecr", access_key_id: "a", secret_access_key: "b" },
          },
        },
        422,
        "validation_error",
      ],
    ];
    for (const [index, [body, status, code]] of cases.entries()) {
      const response = await fetch(`${appUrl}/v1/gpu/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": `invalid-${index}`,
          "x-metal-project-id": project.id,
        },
        body: JSON.stringify(body),
      });
      const error = (await response.json()) as { code: string };
      expect({ index, status: response.status, code: error.code }).toEqual({
        index,
        status,
        code,
      });
    }
    const missingKey = await fetch(`${appUrl}/v1/gpu/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-metal-project-id": project.id,
      },
      body: JSON.stringify(baseRequest),
    });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: "idempotency_key_required" });
    const [count] = await database.sql`
      select count(*)::int as count from metal.gpu_jobs jobs
      join public.projects projects on projects.id = jobs.project_id
      where projects.public_id = ${project.id}
    `;
    expect(count?.count).toBe(0);
  });

  it("serves project members through user-session routes for the dashboard", async () => {
    const { client, userClient, project } = await projectClient({ credits: 50_000_000n });
    const created = await client.gpuJobs.createAsync(baseRequest);
    const [job] = await database.sql`
      select id from metal.gpu_jobs where public_id = ${created.gpu_job.id}
    `;
    await database.sql`
      insert into metal.gpu_job_log_events (gpu_job_id, sequence, type, data)
      values (${job?.id}, 1, 'stdout', ${JSON.stringify({
        data_base64: Buffer.from("ready\n").toString("base64"),
        byte_length: 6,
        stream_offset_bytes: 0,
      })}::jsonb)
    `;

    const listed = await userClient.gpuJobs.listForProject(project.id);
    expect(listed.gpu_jobs.map((item) => item.id)).toEqual([created.gpu_job.id]);
    await expect(
      userClient.gpuJobs.getForProject(project.id, created.gpu_job.id),
    ).resolves.toMatchObject({ id: created.gpu_job.id, state: "requested" });
    const logs = await userClient.gpuJobs.logBatchForProject(project.id, created.gpu_job.id);
    expect(logs.map((event) => [event.sequence, event.type])).toEqual([[1, "stdout"]]);
    await expect(
      userClient.gpuJobs.logBatchForProject(project.id, created.gpu_job.id, { lastEventId: 1 }),
    ).resolves.toEqual([]);

    const cancelled = await userClient.gpuJobs.cancelForProject(project.id, created.gpu_job.id);
    expect(cancelled.gpu_job.state).toBe("cancelled");

    const outsider = await createConfirmedUser(env);
    users.push(outsider.user.id);
    const outsiderClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => outsider.accessToken,
    });
    await expect(outsiderClient.gpuJobs.listForProject(project.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      outsiderClient.gpuJobs.cancelForProject(project.id, created.gpu_job.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(client.gpuJobs.listForProject(project.id)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("requires credits for managed GPU jobs", async () => {
    const { client } = await projectClient();
    await expect(client.gpuJobs.createAsync(baseRequest)).rejects.toMatchObject({
      status: 402,
      code: "insufficient_credits",
    });
  });

  it("requires enough credits to fund the first minutes of a managed job", async () => {
    const { client } = await projectClient({ credits: 5_000_000n });
    await expect(
      client.gpuJobs.createAsync({ ...baseRequest, gpu: { type: "nvidia-t4", count: 1 } }),
    ).resolves.toMatchObject({ gpu_job: { state: "requested" } });
    await expect(
      client.gpuJobs.createAsync({ ...baseRequest, gpu: { type: "nvidia-b300", count: 8 } }),
    ).rejects.toMatchObject({
      status: 402,
      code: "insufficient_credits",
      details: {
        // 8 B300s at $7.0992 each plus Modal's minimum CPU and memory, for 15 minutes.
        required_usd: "14.203586",
        balance_usd: "5.000000",
        funding_window_seconds: 900,
      },
    });
  });

  it("streams stored log events in sequence and stops once logs are complete", async () => {
    const { client } = await projectClient({ credits: 50_000_000n });
    const created = await client.gpuJobs.createAsync(baseRequest);
    const [job] = await database.sql`
      select id from metal.gpu_jobs where public_id = ${created.gpu_job.id}
    `;
    const chunks = ["line one\n", "warning\n", "line two\n"];
    for (const [index, text] of chunks.entries()) {
      await database.sql`
        insert into metal.gpu_job_log_events (gpu_job_id, sequence, type, data)
        values (
          ${job?.id}, ${index + 1}, ${index === 1 ? "stderr" : "stdout"},
          ${JSON.stringify({
            data_base64: Buffer.from(text).toString("base64"),
            byte_length: Buffer.byteLength(text),
            stream_offset_bytes: index === 2 ? Buffer.byteLength(chunks[0]!) : 0,
          })}::jsonb
        )
      `;
    }
    await database.sql`
      update metal.gpu_jobs
      set state = 'succeeded', exit_code = 0, logs_complete = true, finished_at = now()
      where id = ${job?.id}
    `;

    const events = [];
    for await (const event of client.gpuJobs.logs(created.gpu_job.id, { reconnectDelayMs: 0 })) {
      events.push(event);
    }
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "stdout"],
      [2, "stderr"],
      [3, "stdout"],
    ]);
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => Buffer.from(event.data.data_base64, "base64").toString())
        .join(""),
    ).toBe("line one\nline two\n");

    const resumed = [];
    for await (const event of client.gpuJobs.logs(created.gpu_job.id, {
      lastEventId: 2,
      reconnectDelayMs: 0,
    })) {
      resumed.push(event.sequence);
    }
    expect(resumed).toEqual([3]);
    await expect(client.gpuJobs.wait(created.gpu_job.id)).resolves.toMatchObject({
      state: "succeeded",
      exit_code: 0,
    });
  });
});
