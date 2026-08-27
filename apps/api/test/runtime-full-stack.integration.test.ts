import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCredits } from "@openmetal/billing";
import { createDatabase, withTransaction } from "@openmetal/db";
import { MetalClient } from "@openmetal/sdk";
import {
  createConfirmedUser,
  deleteUser,
  FakeSandboxProvider,
  loadTestEnv,
  type TestUser,
} from "@openmetal/testkit";
import { loadWorkerEnv } from "../../worker/src/env.js";
import { processOnce } from "../../worker/src/processor.js";
import { buildApp } from "../src/app.js";
import { loadApiEnv } from "../src/env.js";

const execFileAsync = promisify(execFile);
const testEnv = loadTestEnv();

describe("portable runtime full stack", () => {
  const database = createDatabase({ DATABASE_URL: testEnv.DATABASE_URL });
  const provider = new FakeSandboxProvider("e2b", {
    exec: {
      output: [
        { type: "stdout", data: "out-1\n" },
        { type: "stderr", data: "err-1\n" },
        { type: "stdout", data: "out-2\n" },
      ],
      exitCode: 7,
    },
    runtimeLimits: { maxOutputBytes: 4_096 },
    now: new Date(),
  });
  const publisher = { publish: async () => undefined };
  const workerEnv = loadWorkerEnv({
    ...process.env,
    DATABASE_URL: testEnv.DATABASE_URL,
    SUPABASE_URL: testEnv.SUPABASE_URL,
    SUPABASE_SECRET_KEY: testEnv.SUPABASE_SECRET_KEY,
    WORKER_ID: `runtime-full-stack-${crypto.randomUUID()}`,
    WORKER_LEASE_MS: "5000",
    WORKER_POLL_MS: "50",
    WORKER_BATCH_SIZE: "1",
    WORKER_MAX_ATTEMPTS: "1",
    WORKER_BASE_BACKOFF_MS: "1",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });

  let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;
  let appUrl = "";
  let user: TestUser | undefined;
  let configHome: string | undefined;

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
    appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    user = await createConfirmedUser(testEnv);
    configHome = await mkdtemp(join(tmpdir(), "openmetal-runtime-full-stack-"));
  });

  afterAll(async () => {
    await app?.close();
    if (user) await deleteUser(user.user.id, testEnv);
    if (configHome) await rm(configHome, { recursive: true, force: true });
    await database.shutdown();
  });

  async function internalResourceId(
    kind: "endpoint" | "process" | "runtime_operation" | "sandbox",
    publicId: string,
  ): Promise<string> {
    const rows =
      kind === "sandbox"
        ? await database.sql`select id::text as id from metal.sandboxes where public_id = ${publicId}`
        : kind === "process"
          ? await database.sql`select id::text as id from metal.sandbox_processes where public_id = ${publicId}`
          : kind === "runtime_operation"
            ? await database.sql`select id::text as id from metal.runtime_operations where public_id = ${publicId}`
            : await database.sql`select id::text as id from metal.sandbox_endpoints where public_id = ${publicId}`;
    const id = rows[0]?.id;
    if (!id) throw new Error(`${kind} ${publicId} was not persisted`);
    return String(id);
  }

  async function processJob(
    jobType: string,
    payloadKey: string,
    resourceId: string,
  ): Promise<{ id: string; attempt_count: number }> {
    const [job] = await database.sql`
      select id::text as id, attempt_count
      from metal.outbox_jobs
      where job_type = ${jobType}
        and payload ->> ${payloadKey} = ${resourceId}
      order by created_at desc
      limit 1
    `;
    if (!job?.id) throw new Error(`${jobType} job for ${resourceId} was not persisted`);
    await database.sql`
      update metal.outbox_jobs
      set created_at = now()
      where status = 'pending'
        and created_at < '2000-01-01T00:00:00Z'
        and id <> ${String(job.id)}
    `;
    await database.sql`
      update metal.outbox_jobs
      set created_at = '1900-01-01T00:00:00Z', available_at = now()
      where id = ${String(job.id)}
    `;
    await processOnce(database.db, publisher, workerEnv, { e2b: provider });
    const [completed] = await database.sql`
      select status, attempt_count from metal.outbox_jobs where id = ${String(job.id)}
    `;
    expect(completed?.status).toBe("succeeded");
    return {
      id: String(job.id),
      attempt_count: Number(completed?.attempt_count),
    };
  }

  async function processPublicJob(
    jobType: string,
    kind: "endpoint" | "process" | "runtime_operation" | "sandbox",
    publicId: string,
  ) {
    const payloadKey =
      kind === "sandbox"
        ? "sandbox_id"
        : kind === "process"
          ? "process_id"
          : kind === "endpoint"
            ? "endpoint_id"
            : "runtime_operation_id";
    return processJob(jobType, payloadKey, await internalResourceId(kind, publicId));
  }

  it("runs the SDK and built CLI through API, PostgreSQL, outbox, and fake provider", async () => {
    if (!user || !configHome) throw new Error("full-stack test setup did not complete");

    const ownerClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => user!.accessToken,
      retry: { attempts: 0 },
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const organization = await ownerClient.organizations.create({
      name: "Runtime Full Stack",
      slug: `runtime-full-stack-${suffix}`,
    });
    const project = await ownerClient.projects.create(organization.id, {
      name: "Runtime Project",
      slug: `runtime-${suffix}`,
    });
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, {
        organizationId: organization.id,
        creditMicrousd: 100_000_000n,
        actorId: user!.user.id,
        description: "portable runtime full-stack test",
      }),
    );
    const projectKey = await ownerClient.apiKeys.create(project.id, {
      name: "runtime full-stack key",
      expires_in: null,
    });

    const observedLastEventIds: Array<string | null> = [];
    const observedFetch: typeof fetch = async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(rawUrl).pathname.endsWith("/events") && rawUrl.includes("/processes/")) {
        observedLastEventIds.push(new Headers(init?.headers).get("last-event-id"));
      }
      return fetch(input, init);
    };
    const projectClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => projectKey.key,
      projectId: project.id,
      fetch: observedFetch,
      retry: { attempts: 0 },
    });

    const created = await projectClient.sandboxes.createAsync(
      {
        provider: "e2b",
        source: { kind: "environment", environment: "metal/node", version: "1" },
        resources: { vcpu: 1, memory_mb: 1_024, architecture: "x86_64" },
        lifecycle: { runtime_timeout_seconds: 600 },
      },
      { idempotencyKey: `full-stack-sandbox-${suffix}` },
    );
    expect(created.sandbox.state).toBe("routing");
    await processPublicJob("sandbox.provision", "sandbox", created.sandbox.id);
    await expect(projectClient.sandboxes.get(created.sandbox.id)).resolves.toMatchObject({
      state: "ready",
      provider: "e2b",
    });
    await expect(projectClient.operations.get(created.operation.id)).resolves.toMatchObject({
      state: "succeeded",
      resource_id: created.sandbox.id,
    });

    const executedProcess = await projectClient.processes.create(
      created.sandbox.id,
      {
        command: ["portable-runtime", "--ordered-output"],
        max_output_bytes: 4_096,
      },
      { idempotencyKey: `full-stack-process-${suffix}` },
    );
    const processEventStream = projectClient.processes.events(
      created.sandbox.id,
      executedProcess.id,
      {
        reconnectDelayMs: 0,
      },
    );
    const iterator = processEventStream[Symbol.asyncIterator]();
    const firstEvent = await iterator.next();
    expect(firstEvent.value).toMatchObject({ sequence: 1, type: "queued" });

    const processDelivery = await processPublicJob(
      "process.execute",
      "process",
      executedProcess.id,
    );
    const remainingEvents = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remainingEvents.push(next.value);
    }
    const processEvents = [firstEvent.value!, ...remainingEvents];
    expect(processEvents.map((event) => event.type)).toEqual([
      "queued",
      "started",
      "stdout",
      "stderr",
      "stdout",
      "exited",
    ]);
    expect(
      processEvents
        .filter((event) => event.type === "stdout" || event.type === "stderr")
        .map((event) => Buffer.from(event.data.data_base64, "base64").toString("utf8")),
    ).toEqual(["out-1\n", "err-1\n", "out-2\n"]);
    expect(processEvents.at(-1)).toMatchObject({ type: "exited", data: { exit_code: 7 } });
    expect(observedLastEventIds.slice(0, 2)).toEqual([null, "1"]);
    await expect(
      projectClient.processes.get(created.sandbox.id, executedProcess.id),
    ).resolves.toMatchObject({
      state: "failed",
      exit_code: 7,
      output_bytes: 18,
    });

    const processInternalId = await internalResourceId("process", executedProcess.id);
    const [eventCountBeforeDuplicate] = await database.sql`
      select count(*)::int as count
      from metal.process_events
      where process_id = ${processInternalId}
    `;
    await database.sql`
      update metal.outbox_jobs
      set status = 'pending', available_at = now(), completed_at = null,
          lease_owner = null, lease_expires_at = null
      where id = ${processDelivery.id}
    `;
    const duplicate = await processJob("process.execute", "process_id", processInternalId);
    const [eventCountAfterDuplicate] = await database.sql`
      select count(*)::int as count
      from metal.process_events
      where process_id = ${processInternalId}
    `;
    expect(duplicate.attempt_count).toBe(processDelivery.attempt_count + 1);
    expect(eventCountAfterDuplicate?.count).toBe(eventCountBeforeDuplicate?.count);

    const cliExecutable = resolve(process.cwd(), "../cli/dist/openmetal");
    const cliEnvironment = {
      ...process.env,
      OPENMETAL_API_URL: appUrl,
      OPENMETAL_API_KEY: projectKey.key,
      OPENMETAL_PROJECT_ID: project.id,
      OPENMETAL_CONFIG_HOME: configHome,
    };
    const { stdout: cliProcess } = await execFileAsync(
      cliExecutable,
      ["--json", "process", "get", created.sandbox.id, executedProcess.id],
      { env: cliEnvironment },
    );
    expect(JSON.parse(cliProcess)).toMatchObject({ id: executedProcess.id, exit_code: 7 });

    const cancellable = await projectClient.processes.create(
      created.sandbox.id,
      { command: ["sleep", "60"], max_output_bytes: 4_096 },
      { idempotencyKey: `full-stack-cancel-${suffix}` },
    );
    await expect(
      projectClient.processes.cancel(created.sandbox.id, cancellable.id, {
        idempotencyKey: `full-stack-cancel-request-${suffix}`,
      }),
    ).resolves.toMatchObject({ state: "cancelling" });
    await processPublicJob("process.execute", "process", cancellable.id);
    await processPublicJob("process.cancel", "process", cancellable.id);
    await expect(
      projectClient.processes.get(created.sandbox.id, cancellable.id),
    ).resolves.toMatchObject({ state: "cancelled" });

    const binary = Uint8Array.from([0, 255, 128, 1, 10, 65]);
    const text = "portable runtime text\n";
    const binaryWrite = await projectClient.filesystem.write(
      created.sandbox.id,
      { path: "/workspace/data.bin", data: binary, create_parents: true },
      { idempotencyKey: `full-stack-binary-write-${suffix}` },
    );
    await processPublicJob("filesystem.write", "runtime_operation", binaryWrite.id);
    await expect(
      projectClient.runtimeOperations.get(created.sandbox.id, binaryWrite.id),
    ).resolves.toMatchObject({
      state: "succeeded",
      result: { bytes_written: binary.byteLength },
    });

    const textWrite = await projectClient.filesystem.write(
      created.sandbox.id,
      {
        path: "/workspace/data.txt",
        data_base64: Buffer.from(text).toString("base64"),
        mode: "overwrite",
        create_parents: true,
      },
      { idempotencyKey: `full-stack-text-write-${suffix}` },
    );
    await processPublicJob("filesystem.write", "runtime_operation", textWrite.id);

    const binaryRead = await projectClient.filesystem.read(created.sandbox.id, {
      path: "/workspace/data.bin",
    });
    await processPublicJob("filesystem.read", "runtime_operation", binaryRead.id);
    const completedBinaryRead = await projectClient.runtimeOperations.get(
      created.sandbox.id,
      binaryRead.id,
    );
    expect(completedBinaryRead).toMatchObject({ state: "succeeded" });
    expect(completedBinaryRead.result?.kind).toBe("filesystem_read");
    if (completedBinaryRead.result?.kind !== "filesystem_read") {
      throw new Error("binary read returned the wrong result kind");
    }
    expect(Buffer.from(completedBinaryRead.result.data_base64, "base64")).toEqual(
      Buffer.from(binary),
    );

    const textRead = await projectClient.filesystem.read(created.sandbox.id, {
      path: "/workspace/data.txt",
    });
    await processPublicJob("filesystem.read", "runtime_operation", textRead.id);
    const completedTextRead = await projectClient.runtimeOperations.get(
      created.sandbox.id,
      textRead.id,
    );
    expect(completedTextRead.result?.kind).toBe("filesystem_read");
    if (completedTextRead.result?.kind !== "filesystem_read") {
      throw new Error("text read returned the wrong result kind");
    }
    expect(Buffer.from(completedTextRead.result.data_base64, "base64").toString("utf8")).toBe(text);

    const listedFiles = await projectClient.filesystem.list(created.sandbox.id, {
      path: "/workspace",
      max_entries: 10,
    });
    await processPublicJob("filesystem.list", "runtime_operation", listedFiles.id);
    await expect(
      projectClient.runtimeOperations.get(created.sandbox.id, listedFiles.id),
    ).resolves.toMatchObject({
      state: "succeeded",
      result: {
        entries: [
          { path: "/workspace/data.bin", size_bytes: binary.byteLength },
          { path: "/workspace/data.txt", size_bytes: Buffer.byteLength(text) },
        ],
      },
    });

    for (const [path, idempotencyKey] of [
      ["/workspace/data.bin", `full-stack-delete-binary-${suffix}`],
      ["/workspace/data.txt", `full-stack-delete-text-${suffix}`],
    ] as const) {
      const deletion = await projectClient.filesystem.delete(
        created.sandbox.id,
        { path },
        { idempotencyKey },
      );
      await processPublicJob("filesystem.delete", "runtime_operation", deletion.id);
      await expect(
        projectClient.runtimeOperations.get(created.sandbox.id, deletion.id),
      ).resolves.toMatchObject({ state: "succeeded", result: { path, deleted: true } });
    }

    const unsupported = await projectClient.processes.create(
      created.sandbox.id,
      { command: ["too-much-output"], max_output_bytes: 4_097 },
      { idempotencyKey: `full-stack-unsupported-${suffix}` },
    );
    await processPublicJob("process.execute", "process", unsupported.id);
    await expect(
      projectClient.processes.get(created.sandbox.id, unsupported.id),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "capability_unsupported", retryable: false },
    });

    const endpoint = await projectClient.endpoints.create(
      created.sandbox.id,
      { port: 8_080, lease_seconds: 60 },
      { idempotencyKey: `full-stack-endpoint-${suffix}` },
    );
    await processPublicJob("endpoint.create", "endpoint", endpoint.id);
    await expect(projectClient.endpoints.list(created.sandbox.id)).resolves.toMatchObject({
      endpoints: [expect.objectContaining({ id: endpoint.id, state: "active" })],
    });
    const { stdout: cliEndpoints } = await execFileAsync(
      cliExecutable,
      ["--json", "endpoint", "list", created.sandbox.id],
      { env: cliEnvironment },
    );
    expect(JSON.parse(cliEndpoints)).toMatchObject({
      endpoints: [expect.objectContaining({ id: endpoint.id, state: "active" })],
    });
    await expect(
      projectClient.endpoints.revoke(created.sandbox.id, endpoint.id),
    ).resolves.toMatchObject({ state: "revoking" });
    await processPublicJob("endpoint.revoke", "endpoint", endpoint.id);
    await expect(projectClient.endpoints.list(created.sandbox.id)).resolves.toMatchObject({
      endpoints: [expect.objectContaining({ id: endpoint.id, state: "revoked" })],
    });

    const expiringEndpoint = await projectClient.endpoints.create(
      created.sandbox.id,
      { port: 8_081, lease_seconds: 60 },
      { idempotencyKey: `full-stack-expiring-endpoint-${suffix}` },
    );
    await processPublicJob("endpoint.create", "endpoint", expiringEndpoint.id);
    const expiringEndpointInternalId = await internalResourceId("endpoint", expiringEndpoint.id);
    await database.sql`
      update metal.sandbox_endpoints
      set created_at = now() - interval '2 minutes',
          lease_expires_at = now() - interval '1 minute'
      where id = ${expiringEndpointInternalId}
    `;
    await processOnce(database.db, publisher, workerEnv, { e2b: provider });
    await expect(projectClient.endpoints.list(created.sandbox.id)).resolves.toMatchObject({
      endpoints: expect.arrayContaining([
        expect.objectContaining({ id: expiringEndpoint.id, state: "expired" }),
      ]),
    });
    await processJob("endpoint.revoke", "endpoint_id", expiringEndpointInternalId);

    const isolatedProject = await ownerClient.projects.create(organization.id, {
      name: "Isolated Runtime Project",
      slug: `runtime-isolated-${suffix}`,
    });
    const isolatedKey = await ownerClient.apiKeys.create(isolatedProject.id, {
      name: "isolated runtime key",
      expires_in: null,
    });
    const isolatedClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => isolatedKey.key,
      projectId: isolatedProject.id,
      retry: { attempts: 0 },
    });
    await expect(isolatedClient.sandboxes.get(created.sandbox.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(
      isolatedClient.processes.get(created.sandbox.id, executedProcess.id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const destroyed = await projectClient.sandboxes.deleteAsync(created.sandbox.id, {
      idempotencyKey: `full-stack-destroy-${suffix}`,
    });
    expect(destroyed.sandbox.state).toBe("stopping");
    await processPublicJob("sandbox.destroy", "sandbox", created.sandbox.id);
    await expect(projectClient.operations.get(destroyed.operation.id)).resolves.toMatchObject({
      state: "succeeded",
    });
    await expect(projectClient.sandboxes.get(created.sandbox.id)).resolves.toMatchObject({
      state: "stopped",
    });
    expect(provider.resources.has(created.sandbox.id)).toBe(false);

    const destroyedAgain = await projectClient.sandboxes.deleteAsync(created.sandbox.id, {
      idempotencyKey: `full-stack-destroy-again-${suffix}`,
    });
    expect(destroyedAgain).toMatchObject({
      sandbox: { id: created.sandbox.id, state: "stopped" },
      operation: { state: "succeeded" },
    });

    await ownerClient.apiKeys.revoke(isolatedProject.id, isolatedKey.api_key.id);
    await ownerClient.apiKeys.delete(isolatedProject.id, isolatedKey.api_key.id);
    await ownerClient.apiKeys.revoke(project.id, projectKey.api_key.id);
    await ownerClient.apiKeys.delete(project.id, projectKey.api_key.id);
    await ownerClient.projects.delete(isolatedProject.id);
    await ownerClient.projects.delete(project.id);
  });
});
