import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceSpendLimit, getOrganizationUsageAnalytics, grantCredits } from "@openmetal/billing";
import { createDatabase, withTransaction } from "@openmetal/db";
import {
  ProviderError,
  type GpuJobProvider,
  type ProviderGpuJob,
  type ProviderGpuJobCostInput,
  type ProviderGpuJobListing,
  type ProviderGpuJobLogReadInput,
  type ProviderGpuJobLogReadResult,
  type ProviderGpuJobStatus,
  type ProviderGpuJobSubmitInput,
  type ProviderReportedCost,
  type ProviderSandboxCost,
} from "@openmetal/provider-core";
import { createConfirmedUser, deleteUser, loadTestEnv } from "@openmetal/testkit";
import { loadWorkerEnv } from "../src/env.js";
import {
  reconcileGpuJobCosts,
  scheduleGpuJobMaintenance,
  sweepOrphanedGpuJobs,
  syncGpuJobCostJob,
} from "../src/gpu-jobs.js";
import { processOnce } from "../src/processor.js";

const env = loadTestEnv();

type FakeJob = {
  status: ProviderGpuJobStatus;
  stdout: string[];
  stderr: string[];
  costMicrousd: bigint;
};

class FakeGpuJobProvider implements GpuJobProvider {
  readonly name = "modal" as const;
  readonly capabilities = { cost: true, logs: true, secrets: true, volumes: false };
  readonly jobs = new Map<string, FakeJob>();
  readonly submitted: ProviderGpuJobSubmitInput[] = [];
  readonly cancelled: string[] = [];
  readonly costInputs: ProviderGpuJobCostInput[] = [];
  listed: ProviderGpuJobListing[] = [];
  reported?: bigint;
  discoveredStart?: Date;
  initialStatus: ProviderGpuJobStatus = { state: "running" };
  submitError?: Error;
  reconcileError?: Error;
  reconcileResult?: ProviderGpuJob | null;

  async submit(input: ProviderGpuJobSubmitInput): Promise<ProviderGpuJob> {
    this.submitted.push(input);
    if (this.submitError) throw this.submitError;
    return this.create(input);
  }

  create(input: Pick<ProviderGpuJobSubmitInput, "metalGpuJobId" | "gpu">): ProviderGpuJob {
    const id = `fake-${input.metalGpuJobId}`;
    this.jobs.set(id, {
      status: this.initialStatus,
      stdout: [],
      stderr: [],
      costMicrousd: 0n,
    });
    return {
      providerResourceId: id,
      providerOrganizationId: "fake-app",
      providerMetadata: { fake: true },
      resolved: {
        gpuType: input.gpu.type,
        gpuCount: input.gpu.count,
        providerGpu: "H100",
        vcpu: null,
        memoryMb: null,
      },
    };
  }

  async reconcileSubmit(): Promise<ProviderGpuJob | null> {
    if (this.reconcileError) throw this.reconcileError;
    return this.reconcileResult ?? null;
  }

  async status(id: string): Promise<ProviderGpuJobStatus> {
    return this.jobs.get(id)?.status ?? { state: "absent" };
  }

  async readLogs(input: ProviderGpuJobLogReadInput): Promise<ProviderGpuJobLogReadResult> {
    const job = this.jobs.get(input.providerResourceId);
    const done = job?.status.state !== "running" && job?.status.state !== "pending";
    const chunks: ProviderGpuJobLogReadResult["chunks"] = [];
    const cursors = { ...input.cursors };
    for (const stream of ["stdout", "stderr"] as const) {
      const lines = job?.[stream] ?? [];
      const from = Number(cursors[stream] ?? 0);
      for (const line of lines.slice(from)) {
        chunks.push({ stream, data: new TextEncoder().encode(line) });
      }
      cursors[stream] = String(lines.length);
    }
    return { chunks, cursors, complete: { stdout: done, stderr: done } };
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
    const job = this.jobs.get(id);
    if (job && (job.status.state === "running" || job.status.state === "pending")) {
      job.status = { state: "terminated", exitCode: 137 };
    }
  }

  async startedAt(): Promise<Date | null> {
    return this.discoveredStart ?? null;
  }

  async listActiveJobs(): Promise<ProviderGpuJobListing[]> {
    return this.listed;
  }

  async reportedCost(): Promise<ProviderReportedCost> {
    return { amountMicrousd: this.reported ?? 0n, scope: "fake-app", raw: { fake: true } };
  }

  async getCost(input: ProviderGpuJobCostInput): Promise<ProviderSandboxCost | null> {
    this.costInputs.push(input);
    const job = this.jobs.get(input.providerResourceId);
    if (!job) return null;
    return {
      amountMicrousd: job.costMicrousd,
      providerOrganizationId: "fake-app",
      measuredThrough: input.to,
      provenance: "provider_metered",
      confidence: "high",
      source: "fake",
      raw: { cost: job.costMicrousd.toString() },
    };
  }
}

describe("worker GPU jobs", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  const users: string[] = [];
  const workerEnv = loadWorkerEnv({
    ...process.env,
    DATABASE_URL: env.DATABASE_URL,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    WORKER_ID: `gpu-test-${crypto.randomUUID()}`,
    WORKER_LEASE_MS: "5000",
    WORKER_BATCH_SIZE: "50",
    WORKER_MAX_ATTEMPTS: "3",
    WORKER_BASE_BACKOFF_MS: "10",
    WORKER_GPU_JOB_MONITOR_MS: "250",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });
  const publisher = { publish: async () => {} };

  beforeAll(async () => {
    expect(await database.ready()).toBe(true);
  });

  afterAll(async () => {
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await database.shutdown();
  });

  async function seedOrganization(credits = 10_000_000n) {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'GPU Worker Org', ${`gw-${organizationId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organizationId}, ${user.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId}, ${`prj_${projectId.replaceAll("-", "")}`}, ${organizationId},
        'GPU Worker Project', ${`gwp-${projectId.slice(0, 8)}`}
      )
    `;
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, { organizationId, creditMicrousd: credits, actorId: user.user.id }),
    );
    return { organizationId, projectId, userId: user.user.id };
  }

  async function createJob(
    scope: { organizationId: string; projectId: string; userId: string },
    options: {
      secrets?: Record<string, string>;
      vaultPayload?: Record<string, unknown>;
      maxCostMicrousd?: bigint;
      runtime?: number;
      maxStartSeconds?: number;
      gpuCount?: number;
      estimatedHourlyMicrousd?: bigint;
      priceMultiplierBps?: number;
      placement?: Record<string, unknown>;
      mounts?: Array<Record<string, unknown>>;
      source?: Record<string, unknown>;
    } = {},
  ) {
    const id = crypto.randomUUID();
    const publicId = `gpj_${id.replaceAll("-", "")}`;
    let secretsVaultId: string | null = null;
    const vaultPayload = options.vaultPayload ?? options.secrets;
    if (vaultPayload) {
      const [row] = await database.sql`
        select vault.create_secret(${JSON.stringify(vaultPayload)}, ${`metal:gpu-job:${id}`}) as id
      `;
      secretsVaultId = String(row?.id);
    }
    await database.sql`
      insert into metal.gpu_jobs (
        id, public_id, organization_id, project_id, created_by, primary_provider, source, gpu,
        lifecycle, environment, secret_names, secrets_vault_id, max_cost_microusd, placement,
        mounts, price_multiplier_bps, estimated_hourly_microusd
      ) values (
        ${id}, ${publicId}, ${scope.organizationId}, ${scope.projectId}, ${scope.userId}, 'auto',
        ${JSON.stringify(options.source ?? { kind: "oci_image", image: "pytorch/pytorch:latest", command: ["python", "train.py"] })}::jsonb,
        ${JSON.stringify({ type: "nvidia-h100", count: options.gpuCount ?? 2 })}::jsonb,
        ${JSON.stringify({
          max_runtime_seconds: options.runtime ?? 600,
          ...(options.maxStartSeconds ? { max_start_seconds: options.maxStartSeconds } : {}),
        })}::jsonb,
        ${JSON.stringify({ EPOCHS: "3" })}::jsonb,
        ${JSON.stringify(Object.keys(options.secrets ?? {}))}::jsonb,
        ${secretsVaultId},
        ${options.maxCostMicrousd?.toString() ?? null},
        ${JSON.stringify(options.placement ?? {})}::jsonb,
        ${JSON.stringify(options.mounts ?? [])}::jsonb,
        ${options.priceMultiplierBps ?? 10_000},
        ${(options.estimatedHourlyMicrousd ?? 0n).toString()}
      )
    `;
    const operationId = crypto.randomUUID();
    await database.sql`
      insert into metal.operations (id, public_id, organization_id, project_id, gpu_job_id, type)
      values (
        ${operationId}, ${`op_${operationId.replaceAll("-", "")}`}, ${scope.organizationId},
        ${scope.projectId}, ${id}, 'gpu_job_create'
      )
    `;
    await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values (
        'gpu_job.submit', ${`gpu_job:submit:${id}`},
        ${JSON.stringify({ job_type: "gpu_job.submit", gpu_job_id: id, operation_id: operationId })}::jsonb
      )
    `;
    return { id, publicId, operationId, providerResourceId: `fake-${publicId}` };
  }

  /** Makes the next monitor pass sync cost instead of waiting for the sync interval. */
  async function expireCostSync(id: string) {
    await database.sql`
      update metal.gpu_jobs set provider_cost_updated_at = null where id = ${id}
    `;
  }

  async function job(id: string) {
    const [row] = await database.sql`select * from metal.gpu_jobs where id = ${id}`;
    return row as Record<string, unknown>;
  }

  async function runDue(provider: FakeGpuJobProvider, gpuJobId: string, env = workerEnv) {
    await database.sql`
      update metal.outbox_jobs set available_at = now()
      where status = 'pending' and payload ->> 'gpu_job_id' = ${gpuJobId}
        and job_type <> 'gpu_job.cost.sync'
    `;
    await processOnce(database.db, publisher, env, {}, null, { modal: provider });
  }

  async function runUntil(
    provider: FakeGpuJobProvider,
    gpuJobId: string,
    predicate: (row: Record<string, unknown>) => boolean,
    env = workerEnv,
  ) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await runDue(provider, gpuJobId, env);
      const row = await job(gpuJobId);
      if (predicate(row)) return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `GPU job ${gpuJobId} did not reach the expected state: ${JSON.stringify(await job(gpuJobId))}`,
    );
  }

  it("submits, streams logs, meters cost into the ledger, and finishes", async () => {
    const scope = await seedOrganization(10_000_000n);
    const created = await createJob(scope, { secrets: { HF_TOKEN: "hf_secret" } });
    const provider = new FakeGpuJobProvider();

    const running = await runUntil(provider, created.id, (row) => row.state === "running");
    expect(running).toMatchObject({
      provider: "modal",
      billing_mode: "managed",
      provider_resource_id: created.providerResourceId,
    });
    expect(running.deadline_at).not.toBeNull();
    expect(
      provider.submitted.find((input) => input.metalGpuJobId === created.publicId),
    ).toMatchObject({
      metalGpuJobId: created.publicId,
      image: "pytorch/pytorch:latest",
      command: ["python", "train.py"],
      gpu: { type: "nvidia-h100", count: 2 },
      maxRuntimeSeconds: 600,
      environment: { EPOCHS: "3" },
      secrets: { HF_TOKEN: "hf_secret" },
    });
    const [operation] = await database.sql`
      select state from metal.operations where id = ${created.operationId}
    `;
    expect(operation?.state).toBe("succeeded");
    const scheduled = await database.sql`
      select dedupe_key from metal.outbox_jobs
      where payload ->> 'gpu_job_id' = ${created.id} order by dedupe_key
    `;
    expect(scheduled.map((row) => row.dedupe_key)).toEqual(
      expect.arrayContaining([
        `gpu_job:deadline:${created.id}`,
        `gpu_job:monitor:${created.id}`,
        `gpu_job:submit:${created.id}`,
      ]),
    );

    await expireCostSync(created.id);
    const fake = provider.jobs.get(created.providerResourceId)!;
    fake.stdout.push("epoch 1\n");
    fake.stderr.push("warning: slow\n");
    fake.costMicrousd = 1_000n;
    await runUntil(provider, created.id, (row) => Number(row.log_bytes) > 0);
    const [balanceAfterFirst] = await database.sql`
      select balance_microusd::text as balance from metal.billing_accounts
      where organization_id = ${scope.organizationId}
    `;
    expect(balanceAfterFirst?.balance).toBe("9999000");

    fake.stdout.push("done\n");
    fake.costMicrousd = 1_500n;
    fake.status = { state: "succeeded", exitCode: 0 };
    const finished = await runUntil(provider, created.id, (row) => row.state === "succeeded");
    expect(finished).toMatchObject({
      exit_code: 0,
      logs_complete: true,
      secrets_vault_id: null,
      state_reason: null,
      failure_code: null,
    });
    const events = await database.sql`
      select sequence, type, data from metal.gpu_job_log_events
      where gpu_job_id = ${created.id} order by sequence
    `;
    expect(
      events.map((event) => [
        event.sequence,
        event.type,
        Buffer.from(
          String((event.data as { data_base64: string }).data_base64),
          "base64",
        ).toString(),
        (event.data as { stream_offset_bytes: number }).stream_offset_bytes,
      ]),
    ).toEqual([
      [1, "stdout", "epoch 1\n", 0],
      [2, "stderr", "warning: slow\n", 0],
      [3, "stdout", "done\n", 8],
    ]);
    const [vault] = await database.sql`
      select count(*)::int as count from vault.secrets where name = ${`metal:gpu-job:${created.id}`}
    `;
    expect(vault?.count).toBe(0);
    const charges = await database.sql`
      select customer_charge_microusd::text as charge from metal.usage_charges
      where gpu_job_id = ${created.id} order by created_at
    `;
    expect(charges.map((row) => row.charge)).toEqual(["1000", "500"]);
    const finalCostJobs = await database.sql`
      select count(*)::int as count from metal.outbox_jobs
      where job_type = 'gpu_job.cost.sync' and payload ->> 'gpu_job_id' = ${created.id}
        and (payload ->> 'final')::boolean
    `;
    expect(finalCostJobs[0]?.count).toBe(2);
    const domainEvents = await database.sql`
      select type from metal.domain_events
      where organization_id = ${scope.organizationId} and type like 'gpu_job.%'
      order by cursor
    `;
    expect(domainEvents.map((row) => row.type)).toEqual(
      expect.arrayContaining(["gpu_job.started", "gpu_job.cost_updated", "gpu_job.succeeded"]),
    );
    const [monitor] = await database.sql`
      select status from metal.outbox_jobs where dedupe_key = ${`gpu_job:monitor:${created.id}`}
    `;
    expect(monitor?.status).toBe("succeeded");

    const usage = await getOrganizationUsageAnalytics(database.db, scope.organizationId, {
      through: new Date(Date.now() + 60_000),
    });
    expect(usage.summary.totalCostMicrousd).toBe(1_500n);
    expect(usage.summary.managedCostMicrousd).toBe(1_500n);
    expect(usage.byProvider).toEqual([
      expect.objectContaining({ provider: "modal", costMicrousd: 1_500n }),
    ]);
    expect(usage.topSandboxes).toEqual([]);
    expect(usage.topGpuJobs).toEqual([
      expect.objectContaining({
        gpuJobId: created.publicId,
        costMicrousd: 1_500n,
        status: "succeeded",
      }),
    ]);
    expect(
      usage.gpuJobActivity.map((item) => [item.gpuJobId, item.costDeltaMicrousd]).sort(),
    ).toEqual(
      [
        [created.publicId, 1_000n],
        [created.publicId, 500n],
      ].sort(),
    );
    expect(usage.activity).toEqual([]);
  });

  it("records a nonzero exit as a failed job with its exit code", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    provider.jobs.get(created.providerResourceId)!.status = {
      state: "failed",
      exitCode: 3,
      reason: "exit_code_nonzero",
      message: null,
    };
    const failed = await runUntil(provider, created.id, (row) => row.state === "failed");
    expect(failed).toMatchObject({
      exit_code: 3,
      state_reason: "exit_code_nonzero",
      failure_code: "exit_code_nonzero",
      failure_message: "process exited with code 3",
    });
  });

  it("terminates a running job when the user cancels it", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    const cancelOperationId = crypto.randomUUID();
    await database.sql`
      insert into metal.operations (id, public_id, organization_id, project_id, gpu_job_id, type)
      values (
        ${cancelOperationId}, ${`op_${cancelOperationId.replaceAll("-", "")}`},
        ${scope.organizationId}, ${scope.projectId}, ${created.id}, 'gpu_job_cancel'
      )
    `;
    await database.sql`
      update metal.gpu_jobs
      set state = 'cancelling', cancel_requested_at = now(), cancel_reason = 'cancelled_by_user'
      where id = ${created.id}
    `;
    await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values ('gpu_job.cancel', ${`gpu_job:cancel:${created.id}`}, ${JSON.stringify({
        job_type: "gpu_job.cancel",
        gpu_job_id: created.id,
        operation_id: cancelOperationId,
        reason: "cancelled_by_user",
      })}::jsonb)
    `;
    const cancelled = await runUntil(provider, created.id, (row) => row.state === "cancelled");
    expect(provider.cancelled).toEqual([created.providerResourceId]);
    expect(cancelled).toMatchObject({ state_reason: "cancelled_by_user", failure_code: null });
    const [operation] = await database.sql`
      select state from metal.operations where id = ${cancelOperationId}
    `;
    expect(operation?.state).toBe("succeeded");
  });

  it("cancels a job once its metered cost reaches max_cost_usd", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, { maxCostMicrousd: 1_000n });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await expireCostSync(created.id);
    provider.jobs.get(created.providerResourceId)!.costMicrousd = 1_200n;
    const cancelled = await runUntil(provider, created.id, (row) => row.state === "cancelled");
    expect(cancelled).toMatchObject({
      state_reason: "max_cost_reached",
      cancel_reason: "max_cost_reached",
    });
    const [operation] = await database.sql`
      select state from metal.operations
      where gpu_job_id = ${created.id} and type = 'gpu_job_cancel'
    `;
    expect(operation?.state).toBe("succeeded");
  });

  it("reconciles an unknown submit outcome instead of submitting twice", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    provider.submitError = new ProviderError("socket hang up", "unknown_outcome", true);
    provider.reconcileError = new Error("list failed");
    const uncertain = await runUntil(
      provider,
      created.id,
      (row) => row.state === "provision_unknown",
    );
    expect(uncertain.provider_resource_id).toBeNull();
    const [operation] = await database.sql`
      select state from metal.operations where id = ${created.operationId}
    `;
    expect(operation?.state).toBe("reconciling");

    provider.reconcileError = undefined;
    provider.reconcileResult = provider.create({
      metalGpuJobId: created.publicId,
      gpu: { type: "nvidia-h100", count: 2 },
    });
    const running = await runUntil(provider, created.id, (row) => row.state === "running");
    expect(running.provider_resource_id).toBe(created.providerResourceId);
    expect(
      provider.submitted.filter((input) => input.metalGpuJobId === created.publicId),
    ).toHaveLength(1);
  });

  it("cancels managed GPU jobs when the spend limit is reached", async () => {
    const scope = await seedOrganization(1_000n);
    const created = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await database.sql`
      update metal.billing_accounts set balance_microusd = 0
      where organization_id = ${scope.organizationId}
    `;
    const result = await withTransaction(database.db, (tx) =>
      enforceSpendLimit(tx, scope.organizationId),
    );
    expect(result.terminated).toBeGreaterThanOrEqual(1);
    expect(await job(created.id)).toMatchObject({
      state: "cancelling",
      cancel_reason: "insufficient_credits",
    });
    const cancelled = await runUntil(provider, created.id, (row) => row.state === "cancelled");
    expect(cancelled.state_reason).toBe("insufficient_credits");
  });

  it("times out a job whose provider ignores its runtime limit", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, { runtime: 60 });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await database.sql`
      update metal.gpu_jobs set deadline_at = now() - interval '2 minutes' where id = ${created.id}
    `;
    const timedOut = await runUntil(provider, created.id, (row) => row.state === "timed_out");
    expect(timedOut).toMatchObject({
      state_reason: "max_runtime_exceeded",
      failure_code: "max_runtime_exceeded",
    });
    expect(provider.cancelled).toContain(created.providerResourceId);
  });

  it("fails without provisioning when no GPU provider is configured", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, { secrets: { TOKEN: "value" } });
    await database.sql`
      update metal.outbox_jobs set available_at = now()
      where payload ->> 'gpu_job_id' = ${created.id}
    `;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await processOnce(database.db, publisher, workerEnv, {}, null, {});
      if ((await job(created.id)).state === "failed") break;
    }
    expect(await job(created.id)).toMatchObject({
      state: "failed",
      failure_code: "provider_not_configured",
      secrets_vault_id: null,
      logs_complete: true,
    });
    const [operation] = await database.sql`
      select state, error from metal.operations where id = ${created.operationId}
    `;
    expect(operation).toMatchObject({
      state: "failed",
      error: expect.objectContaining({ code: "provider_not_configured" }),
    });
  });
  it("stays provisioning until the container starts and measures runtime from the start", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, {
      placement: { regions: ["us"] },
      priceMultiplierBps: 11_500,
    });
    const provider = new FakeGpuJobProvider();
    provider.initialStatus = { state: "pending" };

    const waiting = await runUntil(
      provider,
      created.id,
      (row) => row.state === "provisioning" && row.provider_resource_id !== null,
    );
    expect(waiting.submitted_at).not.toBeNull();
    expect(waiting.started_at).toBeNull();
    expect(waiting.deadline_at).toBeNull();
    const submitted = provider.submitted.find((input) => input.metalGpuJobId === created.publicId);
    expect(submitted?.regions).toEqual(["us"]);
    expect(submitted?.providerTimeoutSeconds).toBeGreaterThan(600 + 1_700);

    await runDue(provider, created.id);
    expect((await job(created.id)).state).toBe("provisioning");
    const [started] = await database.sql`
      select count(*)::int as count from metal.domain_events
      where organization_id = ${scope.organizationId} and type = 'gpu_job.started'
    `;
    expect(started?.count).toBe(0);

    provider.jobs.get(created.providerResourceId)!.status = { state: "running" };
    const running = await runUntil(provider, created.id, (row) => row.state === "running");
    expect(running.started_at).not.toBeNull();
    expect(new Date(String(running.deadline_at)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(running.started_at)).getTime() + 600_000,
    );
    expect(provider.costInputs.at(-1)?.priceMultiplierBps).toBe(11_500);
  });

  it("records the provider's start time for a job that finished between monitor passes", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    provider.initialStatus = { state: "pending" };
    await runUntil(provider, created.id, (row) => row.provider_resource_id !== null);
    provider.discoveredStart = new Date(Date.now() - 5_000);
    provider.jobs.get(created.providerResourceId)!.status = { state: "succeeded", exitCode: 0 };
    const finished = await runUntil(provider, created.id, (row) => row.state === "succeeded");
    expect(new Date(String(finished.started_at)).getTime()).toBe(
      provider.discoveredStart.getTime(),
    );
    const events = await database.sql`
      select type from metal.domain_events
      where organization_id = ${scope.organizationId} and type like 'gpu_job.%'
      order by cursor
    `;
    expect(events.map((row) => row.type)).toEqual(["gpu_job.started", "gpu_job.succeeded"]);
  });

  it("fails a job whose container does not start within max_start_seconds", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, { maxStartSeconds: 60 });
    const provider = new FakeGpuJobProvider();
    provider.initialStatus = { state: "pending" };
    await runUntil(provider, created.id, (row) => row.provider_resource_id !== null);
    await database.sql`
      update metal.gpu_jobs set created_at = now() - interval '2 minutes' where id = ${created.id}
    `;
    const failed = await runUntil(provider, created.id, (row) => row.state === "failed");
    expect(failed).toMatchObject({
      state_reason: "start_deadline_exceeded",
      failure_code: "start_deadline_exceeded",
      started_at: null,
    });
    expect(provider.cancelled).toContain(created.providerResourceId);
  });

  it("queues managed jobs behind the organization's GPU limit", async () => {
    const limitedEnv = loadWorkerEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      WORKER_ID: `gpu-cap-${crypto.randomUUID()}`,
      WORKER_LEASE_MS: "5000",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "3",
      WORKER_BASE_BACKOFF_MS: "10",
      WORKER_GPU_JOB_MONITOR_MS: "250",
      WORKER_GPU_JOB_MAX_MANAGED_GPUS_PER_ORGANIZATION: "3",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    const scope = await seedOrganization();
    const first = await createJob(scope, { gpuCount: 2 });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, first.id, (row) => row.state === "running", limitedEnv);
    const second = await createJob(scope, { gpuCount: 2 });

    const queued = await runUntil(
      provider,
      second.id,
      (row) => row.state_reason === "waiting_for_organization_gpu_limit",
      limitedEnv,
    );
    expect(queued.state).toBe("requested");
    expect(provider.submitted.some((input) => input.metalGpuJobId === second.publicId)).toBe(false);

    provider.jobs.get(first.providerResourceId)!.status = { state: "succeeded", exitCode: 0 };
    await runUntil(provider, first.id, (row) => row.state === "succeeded", limitedEnv);
    const started = await runUntil(
      provider,
      second.id,
      (row) => row.state === "running",
      limitedEnv,
    );
    expect(started.state_reason).toBeNull();

    const tooLarge = await createJob(scope, { gpuCount: 4 });
    const rejected = await runUntil(
      provider,
      tooLarge.id,
      (row) => row.state === "failed",
      limitedEnv,
    );
    expect(rejected.failure_code).toBe("gpu_limit_exceeded");
  });

  it("fails a managed job the organization cannot fund when it is claimed", async () => {
    const scope = await seedOrganization(100_000n);
    const created = await createJob(scope, { estimatedHourlyMicrousd: 8_000_000n });
    const provider = new FakeGpuJobProvider();
    const failed = await runUntil(provider, created.id, (row) => row.state === "failed");
    expect(failed.failure_code).toBe("insufficient_credits");
    expect(provider.submitted.some((input) => input.metalGpuJobId === created.publicId)).toBe(
      false,
    );
  });

  it("passes registry and bucket credentials from Vault to the provider", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, {
      source: {
        kind: "oci_image",
        image: "ghcr.io/acme/private:1",
        command: ["python", "train.py"],
        registry_auth: { kind: "basic" },
      },
      mounts: [
        {
          kind: "bucket",
          provider: "r2",
          bucket: "outputs",
          mount_path: "/outputs",
          endpoint_url: "https://acct.r2.cloudflarestorage.com",
          read_only: false,
        },
      ],
      vaultPayload: {
        version: 2,
        environment: { HF_TOKEN: "hf_secret" },
        registry: { kind: "basic", username: "bot", password: "registry-pass" },
        mounts: [{ access_key_id: "AKIA", secret_access_key: "bucket-secret" }],
      },
    });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    expect(
      provider.submitted.find((input) => input.metalGpuJobId === created.publicId),
    ).toMatchObject({
      secrets: { HF_TOKEN: "hf_secret" },
      registryAuth: { kind: "basic", username: "bot", password: "registry-pass" },
      bucketMounts: [
        {
          provider: "r2",
          bucket: "outputs",
          mountPath: "/outputs",
          endpointUrl: "https://acct.r2.cloudflarestorage.com",
          readOnly: false,
          credentials: { accessKeyId: "AKIA", secretAccessKey: "bucket-secret" },
        },
      ],
    });
  });

  it("terminates provider resources that no live job owns", async () => {
    const scope = await seedOrganization();
    const finished = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, finished.id, (row) => row.state === "running");
    provider.jobs.get(finished.providerResourceId)!.status = { state: "succeeded", exitCode: 0 };
    await runUntil(provider, finished.id, (row) => row.state === "succeeded");
    const live = await createJob(scope);
    await runUntil(provider, live.id, (row) => row.state === "running");

    const old = new Date(Date.now() - 60 * 60_000);
    const listing = (
      providerResourceId: string,
      metalGpuJobId: string | null,
      createdAt = old,
    ) => ({
      providerResourceId,
      metalGpuJobId,
      metalEnvironment: "test",
      createdAt,
    });
    provider.listed = [
      listing("leaked-finished", finished.publicId),
      listing("leaked-deleted", "gpj_deleted"),
      listing("duplicate", live.publicId),
      listing(live.providerResourceId, live.publicId),
      listing("fresh", "gpj_new", new Date()),
      listing("untagged", null),
      { ...listing("other-deployment", "gpj_deleted"), metalEnvironment: "production" },
    ];
    const { terminated } = await sweepOrphanedGpuJobs(
      database.db,
      { modal: provider },
      { environment: "test" },
    );
    expect(terminated.sort()).toEqual(["duplicate", "leaked-deleted", "leaked-finished"]);
  });

  it("records drift between metered and provider-reported cost", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope);
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await expireCostSync(created.id);
    provider.jobs.get(created.providerResourceId)!.costMicrousd = 2_000n;
    await runUntil(provider, created.id, (row) => row.provider_cost_microusd === "2000");

    const start = new Date(Date.now() - 60 * 60_000);
    const end = new Date(Date.now() + 60_000);
    const [metered] = await database.sql`
      select coalesce(sum(cost_delta_microusd), 0)::text as amount
      from metal.provider_cost_snapshots
      where gpu_job_id is not null and provider = 'modal' and billing_mode = 'managed'
        and measured_through >= ${start.toISOString()}::timestamptz
        and measured_through < ${end.toISOString()}::timestamptz
    `;
    provider.reported = BigInt(String(metered?.amount)) + 700_000n;
    const [result] = await reconcileGpuJobCosts(database.db, { modal: provider }, { start, end });
    expect(result?.driftMicrousd).toBe(700_000n);
    const [row] = await database.sql`
      select drift_microusd::text as drift from metal.gpu_cost_reconciliations
      where window_start = ${start.toISOString()}::timestamptz
        and window_end = ${end.toISOString()}::timestamptz
    `;
    expect(row?.drift).toBe("700000");
    await database.sql`
      delete from metal.gpu_cost_reconciliations
      where window_start = ${start.toISOString()}::timestamptz
    `;
  });

  it("schedules one sweep and one reconciliation per period", async () => {
    const now = new Date("2031-03-04T12:00:00.000Z");
    await scheduleGpuJobMaintenance(database.db, now);
    await scheduleGpuJobMaintenance(database.db, new Date(now.getTime() + 1_000));
    const rows = await database.sql`
      select job_type, payload from metal.outbox_jobs
      where dedupe_key in (${`gpu_job:orphan_sweep:${Math.floor(now.getTime() / 600_000)}`}, 'gpu_job:cost_reconcile:2031-03-03')
      order by job_type
    `;
    expect(rows.map((row) => row.job_type)).toEqual([
      "gpu_job.cost_reconcile",
      "gpu_job.orphan_sweep",
    ]);
    expect(rows[0]?.payload).toMatchObject({
      window_start: "2031-03-03T00:00:00.000Z",
      window_end: "2031-03-04T00:00:00.000Z",
    });
    await database.sql`
      delete from metal.outbox_jobs
      where dedupe_key in (${`gpu_job:orphan_sweep:${Math.floor(now.getTime() / 600_000)}`}, 'gpu_job:cost_reconcile:2031-03-03')
    `;
  });
  // $3.60 an hour is 1,000 micro-USD per second of container time.
  const ELAPSED_RATE = 3_600_000n;

  async function startedSecondsAgo(id: string, seconds: number) {
    await database.sql`
      update metal.gpu_jobs
      set started_at = now() - make_interval(secs => ${seconds}), provider_cost_updated_at = null
      where id = ${id}
    `;
  }

  it("charges elapsed GPU time while the provider's meter still reads zero", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, { estimatedHourlyMicrousd: ELAPSED_RATE });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await startedSecondsAgo(created.id, 10);

    const charged = await runUntil(
      provider,
      created.id,
      (row) => BigInt(String(row.provider_cost_microusd ?? 0)) >= 10_000n,
    );
    const cost = BigInt(String(charged.provider_cost_microusd));
    expect(cost).toBeGreaterThanOrEqual(10_000n);
    expect(cost).toBeLessThan(15_000n);
    const [snapshot] = await database.sql`
      select cost_provenance, cost_source from metal.provider_cost_snapshots
      where gpu_job_id = ${created.id} order by captured_at desc limit 1
    `;
    expect(snapshot).toMatchObject({
      cost_provenance: "estimated_rate_card",
      cost_source: "metal-gpu-job-elapsed-time",
    });
    const [charge] = await database.sql`
      select coalesce(sum(customer_charge_microusd), 0)::text as total
      from metal.usage_charges where gpu_job_id = ${created.id}
    `;
    expect(charge?.total).toBe(cost.toString());

    // Once the meter catches up and exceeds the estimate, it is billed instead.
    provider.jobs.get(created.providerResourceId)!.costMicrousd = 1_000_000n;
    await expireCostSync(created.id);
    const metered = await runUntil(
      provider,
      created.id,
      (row) => row.provider_cost_microusd === "1000000",
    );
    expect(metered.customer_charged_microusd).toBe("1000000");
  });

  it("cancels at max_cost_usd from elapsed time without waiting for the meter", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, {
      estimatedHourlyMicrousd: ELAPSED_RATE,
      maxCostMicrousd: 5_000n,
    });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await startedSecondsAgo(created.id, 10);
    const cancelled = await runUntil(provider, created.id, (row) => row.state === "cancelled");
    expect(cancelled.state_reason).toBe("max_cost_reached");
    expect(provider.cancelled).toContain(created.providerResourceId);
  });

  it("settles to the provider's meter ten minutes after the job finishes", async () => {
    const scope = await seedOrganization();
    const created = await createJob(scope, { estimatedHourlyMicrousd: ELAPSED_RATE });
    const provider = new FakeGpuJobProvider();
    await runUntil(provider, created.id, (row) => row.state === "running");
    await startedSecondsAgo(created.id, 20);
    const fake = provider.jobs.get(created.providerResourceId)!;
    fake.costMicrousd = 8_000n;
    fake.status = { state: "succeeded", exitCode: 0 };
    const finished = await runUntil(provider, created.id, (row) => row.state === "succeeded");
    expect(BigInt(String(finished.provider_cost_microusd))).toBeGreaterThanOrEqual(20_000n);

    await syncGpuJobCostJob(database.db, { modal: provider }, created.id, true);
    expect((await job(created.id)).provider_cost_microusd).toBe(finished.provider_cost_microusd);

    await database.sql`
      update metal.gpu_jobs set finished_at = now() - interval '11 minutes' where id = ${created.id}
    `;
    await syncGpuJobCostJob(database.db, { modal: provider }, created.id, true);
    const settled = await job(created.id);
    expect(settled).toMatchObject({
      provider_cost_microusd: "8000",
      customer_charged_microusd: "8000",
    });
    const charges = await database.sql`
      select customer_charge_microusd::text as charge from metal.usage_charges
      where gpu_job_id = ${created.id} order by created_at
    `;
    expect(BigInt(String(charges.at(-1)?.charge))).toBeLessThan(0n);
    const [total] = await database.sql`
      select sum(customer_charge_microusd)::text as total from metal.usage_charges
      where gpu_job_id = ${created.id}
    `;
    expect(total?.total).toBe("8000");
  });
});
