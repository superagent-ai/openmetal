import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCredits } from "@openmetal/billing";
import type { CreateSandboxRequest } from "@openmetal/contracts";
import { createDatabase, withTransaction } from "@openmetal/db";
import type { SandboxProviderName } from "@openmetal/provider-core";
import { MetalClient } from "@openmetal/sdk";
import { createConfirmedUser, deleteUser, loadTestEnv, type TestUser } from "@openmetal/testkit";
import { loadWorkerEnv } from "../../worker/src/env.js";
import { processOnce } from "../../worker/src/processor.js";
import { buildSandboxProviders } from "../../worker/src/provider-registry.js";
import { buildApp } from "../src/app.js";
import { loadApiEnv } from "../src/env.js";

const enabled =
  process.env.METAL_LIVE_TESTS === "1" &&
  Boolean(process.env.E2B_API_KEY) &&
  Boolean(process.env.MODAL_TOKEN_ID) &&
  Boolean(process.env.CODESANDBOX_API_KEY);
const testEnv = enabled ? loadTestEnv() : undefined;

(enabled ? describe.sequential : describe.skip)("capability routing live flow", () => {
  if (!testEnv) {
    it.skip("requires live credentials and local Supabase", () => undefined);
    return;
  }
  const database = createDatabase({ DATABASE_URL: testEnv.DATABASE_URL });
  const publisher = { publish: async () => undefined };
  const workerEnv = loadWorkerEnv({
    ...process.env,
    DATABASE_URL: testEnv.DATABASE_URL,
    SUPABASE_URL: testEnv.SUPABASE_URL,
    SUPABASE_SECRET_KEY: testEnv.SUPABASE_SECRET_KEY,
    WORKER_ID: `capability-routing-live-${crypto.randomUUID()}`,
    WORKER_LEASE_MS: "30000",
    WORKER_POLL_MS: "50",
    WORKER_BATCH_SIZE: "1",
    WORKER_MAX_ATTEMPTS: "1",
    WORKER_BASE_BACKOFF_MS: "1",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });
  const providers = buildSandboxProviders(workerEnv);
  const configured = Object.keys(providers) as SandboxProviderName[];
  const suffix = crypto.randomUUID().slice(0, 8);
  const created: Array<{ publicId: string; provider?: SandboxProviderName }> = [];

  let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;
  let user: TestUser | undefined;
  let ownerClient: MetalClient | undefined;
  let projectClient: MetalClient | undefined;
  let organizationId: string | undefined;
  let projectId: string | undefined;
  let apiKeyId: string | undefined;

  beforeAll(async () => {
    const apiEnv = loadApiEnv({
      ...process.env,
      DATABASE_URL: testEnv.DATABASE_URL,
      SUPABASE_URL: testEnv.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: testEnv.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: testEnv.SUPABASE_SECRET_KEY,
      METAL_SITE_URL: "http://localhost:3100",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3100",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    ({ app } = await buildApp(apiEnv, database, { stripe: null }));
    const appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    user = await createConfirmedUser(testEnv);
    ownerClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => user!.accessToken,
      retry: { attempts: 0 },
    });
    const organization = await ownerClient.organizations.create({
      name: "Capability Routing Live",
      slug: `capability-live-${suffix}`,
    });
    organizationId = organization.id;
    const project = await ownerClient.projects.create(organization.id, {
      name: "Capability Routing Live",
      slug: `capability-${suffix}`,
    });
    projectId = project.id;
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, {
        organizationId: organization.id,
        creditMicrousd: 100_000_000n,
        actorId: user!.user.id,
        description: "capability routing live test",
      }),
    );
    const key = await ownerClient.apiKeys.create(project.id, {
      name: "Capability routing live key",
      expires_in: null,
    });
    apiKeyId = key.api_key.id;
    projectClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => key.key,
      projectId: project.id,
      retry: { attempts: 0 },
    });
  }, 120_000);

  afterAll(async () => {
    for (const sandbox of created) {
      const [row] = await database.sql`
        select id::text as id, status, provider, provider_resource_id as "providerResourceId"
        from metal.sandboxes where public_id = ${sandbox.publicId}
      `;
      if (!row?.providerResourceId || row.status === "stopped") continue;
      const provider = providers[row.provider as SandboxProviderName];
      await provider
        ?.destroy(String(row.providerResourceId), AbortSignal.timeout(120_000))
        .catch((error: unknown) => console.error(`cleanup failed for ${sandbox.publicId}`, error));
    }
    if (ownerClient && projectId && apiKeyId) {
      await ownerClient.apiKeys.revoke(projectId, apiKeyId).catch(() => undefined);
      await ownerClient.apiKeys.delete(projectId, apiKeyId).catch(() => undefined);
    }
    if (ownerClient && projectId)
      await ownerClient.projects.delete(projectId).catch(() => undefined);
    if (ownerClient && organizationId) {
      await ownerClient.organizations.delete(organizationId).catch(() => undefined);
    }
    await app?.close();
    if (user) await deleteUser(user.user.id, testEnv);
    await database.shutdown();
  }, 300_000);

  async function processJob(jobType: string, payloadKey: string, resourceId: string) {
    const [job] = await database.sql`
      select id::text as id from metal.outbox_jobs
      where job_type = ${jobType}
        and payload ->> ${payloadKey} = ${resourceId}
        and status in ('pending', 'leased')
      order by created_at desc
      limit 1
    `;
    if (!job?.id) throw new Error(`${jobType} job for ${resourceId} was not persisted`);
    await database.sql`
      update metal.outbox_jobs set created_at = now()
      where status = 'pending' and created_at < '2000-01-01T00:00:00Z' and id <> ${String(job.id)}
    `;
    await database.sql`
      update metal.outbox_jobs
      set created_at = '1900-01-01T00:00:00Z', available_at = now()
      where id = ${String(job.id)}
    `;
    await processOnce(database.db, publisher, workerEnv, providers);
    const [completed] = await database.sql`
      select status, last_error as "lastError" from metal.outbox_jobs where id = ${String(job.id)}
    `;
    expect(completed?.status, String(completed?.lastError ?? "")).toBe("succeeded");
  }

  async function internalId(
    table: "sandboxes" | "sandbox_processes" | "runtime_operations",
    publicId: string,
  ) {
    const rows =
      table === "sandboxes"
        ? await database.sql`select id::text as id from metal.sandboxes where public_id = ${publicId}`
        : table === "sandbox_processes"
          ? await database.sql`select id::text as id from metal.sandbox_processes where public_id = ${publicId}`
          : await database.sql`select id::text as id from metal.runtime_operations where public_id = ${publicId}`;
    if (!rows[0]?.id) throw new Error(`${table} ${publicId} was not persisted`);
    return String(rows[0].id);
  }

  async function provision(label: string, request: Partial<CreateSandboxRequest>) {
    const mutation = await projectClient!.sandboxes.createAsync(
      {
        source: { kind: "environment", environment: "metal/node", version: "live" },
        resources: { vcpu: 1, memory_mb: 1024, architecture: "any" },
        lifecycle: { runtime_timeout_seconds: 600, on_runtime_timeout: "destroy" },
        metadata: { "metal.capability_live_test": suffix },
        ...request,
      },
      { idempotencyKey: `capability-live-${label}-${suffix}` },
    );
    created.push({ publicId: mutation.sandbox.id });
    const started = Date.now();
    await processJob(
      "sandbox.provision",
      "sandbox_id",
      await internalId("sandboxes", mutation.sandbox.id),
    );
    const sandbox = await projectClient!.sandboxes.get(mutation.sandbox.id);
    const operation = await projectClient!.operations.get(mutation.operation.id);
    const attempts = await database.sql`
      select provider, outcome, error_code as "errorCode", exclusions,
        provider_resource_id as "providerResourceId"
      from metal.provider_attempts
      where sandbox_id = ${await internalId("sandboxes", mutation.sandbox.id)}
      order by attempt_index
    `;
    console.info(
      `[capability live] ${label}: state=${sandbox.state} provider=${sandbox.provider ?? "none"} ` +
        `operation=${operation.state}${operation.error ? `/${operation.error.code}` : ""} ` +
        `elapsed_ms=${Date.now() - started}\n` +
        attempts
          .map(
            (attempt) =>
              `  ${String(attempt.provider)}: ${String(attempt.outcome)} ${JSON.stringify(
                (attempt.exclusions as Array<{ requirement: string }>).map((e) => e.requirement),
              )}`,
          )
          .join("\n"),
    );
    return { sandbox, operation, attempts };
  }

  async function runProcess(sandboxId: string, label: string) {
    const process = await projectClient!.processes.create(
      sandboxId,
      { command: ["sh", "-c", "printf routed-stdout; printf routed-stderr >&2"] },
      { idempotencyKey: `capability-live-process-${label}-${suffix}` },
    );
    await processJob(
      "process.execute",
      "process_id",
      await internalId("sandbox_processes", process.id),
    );
    const events = [];
    for await (const event of projectClient!.processes.events(sandboxId, process.id, {
      reconnectDelayMs: 0,
    })) {
      events.push(event);
    }
    const decode = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map((event) =>
          Buffer.from((event.data as { data_base64: string }).data_base64, "base64").toString(),
        )
        .join("");
    return {
      final: await projectClient!.processes.get(sandboxId, process.id),
      stdout: decode("stdout"),
      stderr: decode("stderr"),
    };
  }

  async function destroy(sandboxId: string, label: string) {
    const mutation = await projectClient!.sandboxes.deleteAsync(sandboxId, {
      idempotencyKey: `capability-live-destroy-${label}-${suffix}`,
    });
    await processJob("sandbox.destroy", "sandbox_id", await internalId("sandboxes", sandboxId));
    await expect(projectClient!.operations.get(mutation.operation.id)).resolves.toMatchObject({
      state: "succeeded",
    });
    await expect(projectClient!.sandboxes.get(sandboxId)).resolves.toMatchObject({
      state: "stopped",
    });
  }

  it("skips a lifecycle-only provider under automatic routing and runs on a microVM", async () => {
    const { sandbox, operation, attempts } = await provision("auto-microvm", {
      provider: "auto",
      fallback: { providers: ["codesandbox", "e2b"] },
      features: { isolation: ["microvm"], process: { ordered_output: true } },
    });
    expect(operation.state).toBe("succeeded");
    expect(sandbox).toMatchObject({ state: "ready", provider: "e2b", billing_mode: "managed" });
    expect(attempts).toMatchObject([
      {
        provider: "codesandbox",
        outcome: "ineligible",
        errorCode: "capability_unsupported",
        providerResourceId: null,
        exclusions: [
          { requirement: "process.execute" },
          { requirement: "process.ordered_output" },
          { requirement: "filesystem.read" },
          { requirement: "filesystem.write" },
        ],
      },
      { provider: "e2b", outcome: "created", exclusions: [] },
    ]);
    await expect(
      providers.codesandbox!.reconcileCreate!(await internalId("sandboxes", sandbox.id)),
    ).resolves.toBeNull();

    const result = await runProcess(sandbox.id, "e2b");
    expect(result.final).toMatchObject({ state: "succeeded", exit_code: 0 });
    expect(result.stdout).toBe("routed-stdout");
    expect(result.stderr).toBe("routed-stderr");

    const payload = new TextEncoder().encode(`capability-${suffix}`);
    const write = await projectClient!.filesystem.write(
      sandbox.id,
      { path: "/tmp/capability-live.txt", data: payload, mode: "overwrite" },
      { idempotencyKey: `capability-live-write-${suffix}` },
    );
    await processJob(
      "filesystem.write",
      "runtime_operation_id",
      await internalId("runtime_operations", write.id),
    );
    const read = await projectClient!.filesystem.read(sandbox.id, {
      path: "/tmp/capability-live.txt",
    });
    await processJob(
      "filesystem.read",
      "runtime_operation_id",
      await internalId("runtime_operations", read.id),
    );
    const completedRead = await projectClient!.runtimeOperations.get(sandbox.id, read.id);
    expect(completedRead.state).toBe("succeeded");
    if (completedRead.result?.kind !== "filesystem_read") throw new Error("expected a read result");
    expect(Buffer.from(completedRead.result.data_base64, "base64").toString()).toBe(
      `capability-${suffix}`,
    );

    await destroy(sandbox.id, "e2b");
  }, 600_000);

  it("excludes a microVM provider when only container isolation is acceptable", async () => {
    const { sandbox, operation, attempts } = await provision("container", {
      provider: "auto",
      fallback: { providers: ["e2b", "modal"] },
      features: { isolation: ["container"], process: { ordered_output: true } },
    });
    expect(operation.state).toBe("succeeded");
    expect(sandbox).toMatchObject({ state: "ready", provider: "modal" });
    expect(attempts).toMatchObject([
      {
        provider: "e2b",
        outcome: "ineligible",
        providerResourceId: null,
        exclusions: [{ requirement: "isolation" }],
      },
      { provider: "modal", outcome: "created", exclusions: [] },
    ]);
    const result = await runProcess(sandbox.id, "modal");
    expect(result.final).toMatchObject({ state: "succeeded", exit_code: 0 });
    expect(result.stdout).toBe("routed-stdout");
    expect(result.stderr).toBe("routed-stderr");
    await destroy(sandbox.id, "modal");
  }, 600_000);

  it("fails closed without provisioning when no provider can enforce the request", async () => {
    const { sandbox, operation, attempts } = await provision("unenforceable", {
      provider: "auto",
      regions: ["eu-west"],
      network: { allow_domains: ["example.com"] },
      features: { pty: true },
    });
    expect(sandbox.state).toBe("failed");
    expect(operation).toMatchObject({
      state: "failed",
      error: {
        code: "no_eligible_provider",
        message: "no candidate provider satisfies the requested capabilities",
        retryable: false,
      },
    });
    expect(attempts).toHaveLength(configured.length);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ outcome: "ineligible", providerResourceId: null });
      expect(
        (attempt.exclusions as Array<{ requirement: string }>).map((e) => e.requirement),
      ).toEqual(expect.arrayContaining(["network.allow_domains", "regions", "pty"]));
    }
    const details = operation.error?.details as {
      attempts: Array<{ provider: string; unmet_requirements: string[] }>;
    };
    expect(details.attempts.map((attempt) => attempt.provider)).toEqual(
      attempts.map((attempt) => attempt.provider),
    );
  }, 120_000);

  it("rejects an explicit provider that lacks a requested capability", async () => {
    const { sandbox, operation, attempts } = await provision("explicit-codesandbox", {
      provider: "codesandbox",
      features: { process: { execute: true } },
    });
    expect(sandbox.state).toBe("failed");
    expect(operation.error).toMatchObject({
      code: "no_eligible_provider",
      details: {
        attempts: [
          {
            provider: "codesandbox",
            code: "capability_unsupported",
            unmet_requirements: ["process.execute"],
          },
        ],
      },
    });
    expect(attempts).toMatchObject([{ provider: "codesandbox", providerResourceId: null }]);
  }, 120_000);

  it("aggregates the run into the capability demand views", async () => {
    const [excluded] = await database.sql`
      select sandboxes from metal.capability_exclusions_daily
      where day = (now() at time zone 'utc')::date
        and provider = 'e2b' and requirement = 'isolation'
    `;
    expect(Number(excluded?.sandboxes)).toBeGreaterThanOrEqual(1);
    const unserved = await database.sql`
      select requirement from metal.unserved_requirements_daily
      where day = (now() at time zone 'utc')::date
        and requirement in ('network.allow_domains', 'regions', 'pty', 'process.execute')
      order by requirement
    `;
    expect(unserved.map((row) => row.requirement)).toEqual([
      "network.allow_domains",
      "process.execute",
      "pty",
      "regions",
    ]);
  });
});
