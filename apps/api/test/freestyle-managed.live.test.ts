import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCredits } from "@openmetal/billing";
import { createDatabase, withTransaction } from "@openmetal/db";
import type { SandboxProvider } from "@openmetal/provider-core";
import { MetalClient } from "@openmetal/sdk";
import { createConfirmedUser, deleteUser, loadTestEnv, type TestUser } from "@openmetal/testkit";
import { loadWorkerEnv } from "../../worker/src/env.js";
import { processOnce } from "../../worker/src/processor.js";
import { buildSandboxProviders } from "../../worker/src/provider-registry.js";
import { buildApp } from "../src/app.js";
import { loadApiEnv } from "../src/env.js";

const enabled = process.env.METAL_LIVE_TESTS === "1" && Boolean(process.env.FREESTYLE_API_KEY);
const testEnv = enabled ? loadTestEnv() : undefined;

(enabled ? describe.sequential : describe.skip)("managed Freestyle API live flow", () => {
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
    WORKER_ID: `freestyle-api-live-${crypto.randomUUID()}`,
    WORKER_LEASE_MS: "5000",
    WORKER_POLL_MS: "50",
    WORKER_BATCH_SIZE: "1",
    WORKER_MAX_ATTEMPTS: "1",
    WORKER_BASE_BACKOFF_MS: "1",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });
  const provider = buildSandboxProviders(workerEnv).freestyle as SandboxProvider | undefined;

  let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;
  let appUrl = "";
  let user: TestUser | undefined;

  beforeAll(async () => {
    expect(provider).toBeDefined();
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
  });

  afterAll(async () => {
    await app?.close();
    if (user) await deleteUser(user.user.id, testEnv);
    await database.shutdown();
  });

  async function internalSandbox(publicId: string): Promise<{
    id: string;
    providerResourceId: string | null;
  }> {
    const [row] = await database.sql`
      select id::text as id, provider_resource_id as "providerResourceId"
      from metal.sandboxes
      where public_id = ${publicId}
    `;
    if (!row?.id) throw new Error(`sandbox ${publicId} was not persisted`);
    return {
      id: String(row.id),
      providerResourceId:
        typeof row.providerResourceId === "string" ? row.providerResourceId : null,
    };
  }

  async function publicResourceId(
    kind: "runtime_operation" | "sandbox",
    publicId: string,
  ): Promise<string> {
    if (kind === "sandbox") return (await internalSandbox(publicId)).id;
    const [row] = await database.sql`
      select id::text as id
      from metal.runtime_operations
      where public_id = ${publicId}
    `;
    if (!row?.id) throw new Error(`${kind} ${publicId} was not persisted`);
    return String(row.id);
  }

  async function processJob(
    jobType: string,
    payloadKey: string,
    resourceId: string,
  ): Promise<void> {
    const [job] = await database.sql`
      select id::text as id
      from metal.outbox_jobs
      where job_type = ${jobType}
        and payload ->> ${payloadKey} = ${resourceId}
        and status in ('pending', 'leased')
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
    await processOnce(database.db, publisher, workerEnv, { freestyle: provider! });
    const [completed] = await database.sql`
      select status, last_error as "lastError"
      from metal.outbox_jobs
      where id = ${String(job.id)}
    `;
    expect(completed?.status, String(completed?.lastError ?? "")).toBe("succeeded");
  }

  async function processPublicJob(
    jobType: string,
    kind: "runtime_operation" | "sandbox",
    publicId: string,
  ): Promise<void> {
    const payloadKey = kind === "sandbox" ? "sandbox_id" : "runtime_operation_id";
    await processJob(jobType, payloadKey, await publicResourceId(kind, publicId));
  }

  it("runs managed Freestyle through the public API, persists cost, charges usage, and destroys it", async () => {
    if (!user || !provider) throw new Error("Freestyle API live setup did not complete");

    const ownerClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => user!.accessToken,
      retry: { attempts: 0 },
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    let organizationId: string | undefined;
    let projectId: string | undefined;
    let projectKey: Awaited<ReturnType<typeof ownerClient.apiKeys.create>> | undefined;
    let projectClient: MetalClient | undefined;
    let sandboxPublicId: string | undefined;
    let sandboxInternalId: string | undefined;
    let providerResourceId: string | undefined;
    let destroyedThroughApi = false;

    try {
      const organization = await ownerClient.organizations.create({
        name: "Freestyle API Live",
        slug: `freestyle-api-live-${suffix}`,
      });
      organizationId = organization.id;
      const project = await ownerClient.projects.create(organization.id, {
        name: "Freestyle API Live",
        slug: `freestyle-${suffix}`,
      });
      projectId = project.id;
      await withTransaction(database.db, (tx) =>
        grantCredits(tx, {
          organizationId: organization.id,
          creditMicrousd: 100_000_000n,
          actorId: user!.user.id,
          description: "managed Freestyle API live test",
        }),
      );
      projectKey = await ownerClient.apiKeys.create(project.id, {
        name: "Freestyle API live key",
        expires_in: null,
      });
      projectClient = new MetalClient({
        baseUrl: appUrl,
        accessToken: () => projectKey!.key,
        projectId: project.id,
        retry: { attempts: 0 },
      });

      const created = await projectClient.sandboxes.createAsync(
        {
          provider: "freestyle",
          source: {
            kind: "environment",
            environment: "metal/node",
            version: "live",
          },
          resources: { vcpu: 0.5, memory_mb: 512, architecture: "any" },
          lifecycle: {
            runtime_timeout_seconds: 600,
            on_runtime_timeout: "destroy",
          },
          metadata: { "metal.api_live_test": "1" },
        },
        { idempotencyKey: `freestyle-api-live-${suffix}` },
      );
      sandboxPublicId = created.sandbox.id;
      await processPublicJob("sandbox.provision", "sandbox", sandboxPublicId);
      await expect(projectClient.sandboxes.get(sandboxPublicId)).resolves.toMatchObject({
        state: "ready",
        provider: "freestyle",
        billing_mode: "managed",
        resolved_resources: {
          vcpu: 2,
          memory_mb: 4_096,
          disk_mb: 16_384,
          architecture: "x86_64",
          provider_size: "freestyle/ubuntu-sm",
        },
      });
      const internal = await internalSandbox(sandboxPublicId);
      sandboxInternalId = internal.id;
      providerResourceId = internal.providerResourceId ?? undefined;
      expect(providerResourceId).toBeTruthy();

      const binary = Uint8Array.from([0, 255, 128, 1, 10, 65]);
      const write = await projectClient.filesystem.write(
        sandboxPublicId,
        {
          path: "/workspace/api-live.bin",
          data: binary,
          mode: "overwrite",
          create_parents: true,
        },
        { idempotencyKey: `freestyle-api-write-${suffix}` },
      );
      await processPublicJob("filesystem.write", "runtime_operation", write.id);
      await expect(
        projectClient.runtimeOperations.get(sandboxPublicId, write.id),
      ).resolves.toMatchObject({
        state: "succeeded",
        result: { kind: "filesystem_write", bytes_written: binary.byteLength },
      });

      const read = await projectClient.filesystem.read(sandboxPublicId, {
        path: "/workspace/api-live.bin",
      });
      await processPublicJob("filesystem.read", "runtime_operation", read.id);
      const completedRead = await projectClient.runtimeOperations.get(sandboxPublicId, read.id);
      expect(completedRead.result?.kind).toBe("filesystem_read");
      if (completedRead.result?.kind !== "filesystem_read") {
        throw new Error("Freestyle API binary read returned the wrong result kind");
      }
      expect(Buffer.from(completedRead.result.data_base64, "base64")).toEqual(Buffer.from(binary));

      const process = await projectClient.processes.create(
        sandboxPublicId,
        { command: ["sh", "-lc", "printf should-not-run"] },
        { idempotencyKey: `freestyle-api-process-${suffix}` },
      );
      const processInternalId = await database.sql`
          select id::text as id
          from metal.sandbox_processes
          where public_id = ${process.id}
        `.then((rows) => String(rows[0]?.id));
      await processJob("process.execute", "process_id", processInternalId);
      await expect(projectClient.processes.get(sandboxPublicId, process.id)).resolves.toMatchObject(
        {
          state: "failed",
          error: { code: "capability_unsupported", retryable: false },
        },
      );

      const paused = await projectClient.sandboxes.pauseAsync(sandboxPublicId, {
        idempotencyKey: `freestyle-api-pause-${suffix}`,
      });
      await processPublicJob("sandbox.pause", "sandbox", sandboxPublicId);
      await expect(projectClient.operations.get(paused.operation.id)).resolves.toMatchObject({
        state: "succeeded",
      });
      await expect(projectClient.sandboxes.get(sandboxPublicId)).resolves.toMatchObject({
        state: "paused",
      });

      await processJob("sandbox.cost.sync", "sandbox_id", sandboxInternalId);
      const [costSnapshot] = await database.sql`
          select
            amount_microusd as "amountMicrousd",
            cost_delta_microusd as "costDeltaMicrousd",
            cost_provenance as "costProvenance",
            cost_confidence as "costConfidence",
            rate_card_version as "rateCardVersion"
          from metal.provider_cost_snapshots
          where sandbox_id = ${sandboxInternalId}
          order by captured_at desc
          limit 1
        `;
      expect(BigInt(String(costSnapshot?.amountMicrousd ?? "0"))).toBeGreaterThan(0n);
      expect(BigInt(String(costSnapshot?.costDeltaMicrousd ?? "0"))).toBeGreaterThan(0n);
      expect(costSnapshot).toMatchObject({
        costProvenance: "estimated_rate_card",
        costConfidence: "low",
        rateCardVersion: "2026-09-10",
      });
      const [usageCharge] = await database.sql`
          select
            provider_cost_delta_microusd as "providerCostDeltaMicrousd",
            customer_charge_microusd as "customerChargeMicrousd"
          from metal.usage_charges
          where sandbox_id = ${sandboxInternalId}
          order by created_at desc
          limit 1
        `;
      expect(BigInt(String(usageCharge?.providerCostDeltaMicrousd ?? "0"))).toBeGreaterThan(0n);
      expect(BigInt(String(usageCharge?.customerChargeMicrousd ?? "0"))).toBeGreaterThan(0n);
      const [ledger] = await database.sql`
          select count(*)::int as count
          from metal.ledger_transactions
          where organization_id = ${organization.id}
            and kind = 'usage_charge'
        `;
      expect(Number(ledger?.count)).toBeGreaterThan(0);
      console.info(
        `[metal freestyle api live] initial cost=${String(
          costSnapshot?.amountMicrousd,
        )} microusd charge=${String(
          usageCharge?.customerChargeMicrousd,
        )} microusd ledger_transactions=${String(ledger?.count)}`,
      );

      const resumed = await projectClient.sandboxes.resumeAsync(sandboxPublicId, {
        idempotencyKey: `freestyle-api-resume-${suffix}`,
      });
      await processPublicJob("sandbox.resume", "sandbox", sandboxPublicId);
      await expect(projectClient.operations.get(resumed.operation.id)).resolves.toMatchObject({
        state: "succeeded",
      });
      await expect(projectClient.sandboxes.get(sandboxPublicId)).resolves.toMatchObject({
        state: "ready",
      });

      const deletion = await projectClient.filesystem.delete(
        sandboxPublicId,
        { path: "/workspace/api-live.bin" },
        { idempotencyKey: `freestyle-api-delete-file-${suffix}` },
      );
      await processPublicJob("filesystem.delete", "runtime_operation", deletion.id);
      await expect(
        projectClient.runtimeOperations.get(sandboxPublicId, deletion.id),
      ).resolves.toMatchObject({
        state: "succeeded",
        result: { path: "/workspace/api-live.bin", deleted: true },
      });

      const destroyed = await projectClient.sandboxes.deleteAsync(sandboxPublicId, {
        idempotencyKey: `freestyle-api-destroy-${suffix}`,
      });
      await processPublicJob("sandbox.destroy", "sandbox", sandboxPublicId);
      await expect(projectClient.operations.get(destroyed.operation.id)).resolves.toMatchObject({
        state: "succeeded",
      });
      await expect(projectClient.sandboxes.get(sandboxPublicId)).resolves.toMatchObject({
        state: "stopped",
        provider: "freestyle",
      });
      destroyedThroughApi = true;

      await processJob("sandbox.cost.sync", "sandbox_id", sandboxInternalId);
      const [finalSandbox] = await database.sql`
          select
            provider_cost_microusd as "providerCostMicrousd",
            provider_cost_measured_through as "providerCostMeasuredThrough",
            deleted_at as "deletedAt"
          from metal.sandboxes
          where id = ${sandboxInternalId}
        `;
      expect(BigInt(String(finalSandbox?.providerCostMicrousd ?? "0"))).toBeGreaterThan(0n);
      const measuredThrough = new Date(String(finalSandbox?.providerCostMeasuredThrough));
      const deletedAt = new Date(String(finalSandbox?.deletedAt));
      expect(measuredThrough.getTime()).toBeLessThanOrEqual(deletedAt.getTime());
      expect(deletedAt.getTime() - measuredThrough.getTime()).toBeLessThan(5_000);
      await expect(provider.reconcileCreate(sandboxInternalId)).resolves.toBeNull();
      console.info(
        `[metal freestyle api live] final cost=${String(
          finalSandbox?.providerCostMicrousd,
        )} microusd measured_through=${measuredThrough.toISOString()} deleted_at=${deletedAt.toISOString()}`,
      );
    } finally {
      if (!destroyedThroughApi && sandboxPublicId && projectClient) {
        try {
          await projectClient.sandboxes.deleteAsync(sandboxPublicId, {
            idempotencyKey: `freestyle-api-finally-${suffix}`,
          });
          await processPublicJob("sandbox.destroy", "sandbox", sandboxPublicId);
        } catch {
          // The direct provider fallback below guarantees external cleanup.
        }
      }
      if (providerResourceId) {
        await provider.destroy(providerResourceId, AbortSignal.timeout(120_000));
      }
      if (sandboxInternalId) {
        await expect(provider.reconcileCreate(sandboxInternalId)).resolves.toBeNull();
      }
      if (projectKey && projectId) {
        await ownerClient.apiKeys.revoke(projectId, projectKey.api_key.id).catch(() => undefined);
        await ownerClient.apiKeys.delete(projectId, projectKey.api_key.id).catch(() => undefined);
      }
      if (projectId) await ownerClient.projects.delete(projectId).catch(() => undefined);
      if (organizationId) {
        await ownerClient.organizations.delete(organizationId).catch(() => undefined);
      }
    }
  }, 300_000);
});
