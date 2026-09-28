import { afterAll, describe, expect, it } from "vitest";
import { grantCredits } from "@openmetal/billing";
import { createDatabase, withTransaction } from "@openmetal/db";
import {
  createConfirmedUser,
  deleteGpuJobsForOrganizations,
  deleteUser,
  loadTestEnv,
} from "@openmetal/testkit";
import { loadWorkerEnv } from "../src/env.js";
import { syncGpuJobCostJob } from "../src/gpu-jobs.js";
import { processOnce } from "../src/processor.js";
import { buildGpuJobProviders } from "../src/provider-registry.js";

const enabled =
  process.env.METAL_LIVE_TESTS === "1" &&
  Boolean(
    (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) ||
    (process.env.MODAL_GPU_TOKEN_ID && process.env.MODAL_GPU_TOKEN_SECRET),
  );
const liveTimeoutMs = Number(process.env.METAL_LIVE_TIMEOUT_MS ?? 420_000);

describe.skipIf(!enabled)("live Modal GPU jobs", () => {
  const env = loadTestEnv();
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  const workerEnv = loadWorkerEnv({
    ...process.env,
    DATABASE_URL: env.DATABASE_URL,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    WORKER_ID: `gpu-live-${crypto.randomUUID()}`,
    WORKER_MAX_ATTEMPTS: "5",
    WORKER_GPU_JOB_MONITOR_MS: "1000",
    MODAL_GPU_APP_NAME: "metal-gpu-jobs-live-test",
    LOG_LEVEL: "silent",
    METAL_ENVIRONMENT: "test",
  });
  const providers = buildGpuJobProviders(workerEnv);
  const users: string[] = [];
  const organizations: string[] = [];
  const providerResources = new Set<string>();
  const publisher = { publish: async () => {} };

  afterAll(async () => {
    for (const resource of providerResources) {
      await providers.modal?.cancel(resource).catch(() => undefined);
    }
    await deleteGpuJobsForOrganizations(database.sql, organizations);
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await database.shutdown();
  });

  async function seedJob(
    command: string[],
    secrets: Record<string, string> = {},
    placement: { regions?: string[] } = {},
  ) {
    const user = await createConfirmedUser(env);
    users.push(user.user.id);
    const organizationId = crypto.randomUUID();
    organizations.push(organizationId);
    const projectId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'GPU Live Org', ${`gl-${organizationId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId}, ${`prj_${projectId.replaceAll("-", "")}`}, ${organizationId},
        'GPU Live Project', ${`glp-${projectId.slice(0, 8)}`}
      )
    `;
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, { organizationId, creditMicrousd: 5_000_000n, actorId: user.user.id }),
    );
    const id = crypto.randomUUID();
    const [secret] = await database.sql`
      select vault.create_secret(${JSON.stringify({
        version: 2,
        environment: secrets,
        registry: null,
        mounts: [],
      })}, ${`metal:gpu-job:${id}`}) as id
    `;
    await database.sql`
      insert into metal.gpu_jobs (
        id, public_id, organization_id, project_id, created_by, primary_provider, source, gpu,
        lifecycle, environment, secret_names, secrets_vault_id, placement, price_multiplier_bps,
        estimated_hourly_microusd
      ) values (
        ${id}, ${`gpj_${id.replaceAll("-", "")}`}, ${organizationId}, ${projectId},
        ${user.user.id}, 'modal',
        ${JSON.stringify({ kind: "oci_image", image: "python:3.13-slim", command })}::jsonb,
        ${JSON.stringify({ type: "nvidia-t4", count: 1 })}::jsonb,
        ${JSON.stringify({ max_runtime_seconds: 900 })}::jsonb,
        ${JSON.stringify({ RUN_LABEL: "live" })}::jsonb,
        ${JSON.stringify(Object.keys(secrets))}::jsonb,
        ${String(secret?.id)},
        ${JSON.stringify(placement)}::jsonb,
        ${placement.regions?.length ? 11_500 : 10_000},
        700000
      )
    `;
    const operationId = crypto.randomUUID();
    await database.sql`
      insert into metal.operations (id, public_id, organization_id, project_id, gpu_job_id, type)
      values (
        ${operationId}, ${`op_${operationId.replaceAll("-", "")}`}, ${organizationId},
        ${projectId}, ${id}, 'gpu_job_create'
      )
    `;
    await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload)
      values ('gpu_job.submit', ${`gpu_job:submit:${id}`}, ${JSON.stringify({
        job_type: "gpu_job.submit",
        gpu_job_id: id,
        operation_id: operationId,
      })}::jsonb)
    `;
    return { id, organizationId, projectId };
  }

  async function row(id: string) {
    const [job] = await database.sql`select * from metal.gpu_jobs where id = ${id}`;
    if (job?.provider_resource_id) providerResources.add(String(job.provider_resource_id));
    return job as Record<string, unknown>;
  }

  async function processUntil(id: string, predicate: (job: Record<string, unknown>) => boolean) {
    const deadline = Date.now() + liveTimeoutMs;
    while (Date.now() < deadline) {
      await database.sql`
        update metal.outbox_jobs set available_at = now()
        where status = 'pending' and payload ->> 'gpu_job_id' = ${id}
          and job_type <> 'gpu_job.cost.sync'
      `;
      await processOnce(database.db, publisher, workerEnv, {}, null, providers);
      const job = await row(id);
      if (predicate(job)) return job;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      `GPU job ${id} did not reach the expected state: ${JSON.stringify(await row(id))}`,
    );
  }

  async function logText(id: string, type: "stdout" | "stderr") {
    const events = await database.sql`
      select data from metal.gpu_job_log_events
      where gpu_job_id = ${id} and type = ${type} order by sequence
    `;
    return events
      .map((event) =>
        Buffer.from(
          String((event.data as { data_base64: string }).data_base64),
          "base64",
        ).toString(),
      )
      .join("");
  }

  it(
    "runs a T4 job to completion with logs, injected secrets, and metered cost",
    async () => {
      const created = await seedJob(
        [
          "sh",
          "-c",
          'nvidia-smi --query-gpu=name --format=csv,noheader; echo "label=$RUN_LABEL"; echo "secret-length=${#LIVE_SECRET}"; echo live-stderr >&2; sleep 3',
        ],
        { LIVE_SECRET: "abc123" },
        { regions: ["us"] },
      );
      const finished = await processUntil(created.id, (job) =>
        ["succeeded", "failed", "timed_out", "cancelled"].includes(String(job.state)),
      );
      expect(finished).toMatchObject({
        state: "succeeded",
        exit_code: 0,
        provider: "modal",
        billing_mode: "managed",
        logs_complete: true,
        secrets_vault_id: null,
        price_multiplier_bps: 11_500,
      });
      expect(finished.submitted_at).not.toBeNull();
      expect(finished.started_at).not.toBeNull();
      expect(new Date(String(finished.started_at)).getTime()).toBeGreaterThanOrEqual(
        new Date(String(finished.submitted_at)).getTime(),
      );
      const stdout = await logText(created.id, "stdout");
      expect(stdout).toContain("T4");
      expect(stdout).toContain("label=live");
      expect(stdout).toContain("secret-length=6");
      expect(stdout).not.toContain("abc123");
      expect(await logText(created.id, "stderr")).toContain("live-stderr");

      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await syncGpuJobCostJob(database.db, providers, created.id, false);
      const costed = await row(created.id);
      expect(BigInt(String(costed.provider_cost_microusd))).toBeGreaterThan(0n);
      const [charge] = await database.sql`
        select coalesce(sum(customer_charge_microusd), 0)::text as total
        from metal.usage_charges where gpu_job_id = ${created.id}
      `;
      expect(charge?.total).toBe(String(costed.provider_cost_microusd));
      // Settlement replaces the elapsed-time charge with Modal's metered usage,
      // or with Modal's task window when the meter reports less.
      await database.sql`
        update metal.gpu_jobs set finished_at = now() - interval '11 minutes'
        where id = ${created.id}
      `;
      await syncGpuJobCostJob(database.db, providers, created.id, true);
      const settled = await row(created.id);
      const [snapshot] = await database.sql`
        select cost_source from metal.provider_cost_snapshots
        where gpu_job_id = ${created.id} order by captured_at desc limit 1
      `;
      expect([
        "modal-gpu-sandbox-resource-usage-published-rate-card",
        "metal-gpu-job-provider-task-time",
      ]).toContain(snapshot?.cost_source);
      const [settledCharge] = await database.sql`
        select coalesce(sum(customer_charge_microusd), 0)::text as total
        from metal.usage_charges where gpu_job_id = ${created.id}
      `;
      expect(settledCharge?.total).toBe(String(settled.provider_cost_microusd));

      const now = new Date();
      const reported = await providers.modal!.reportedCost!({
        from: new Date(now.getTime() - 24 * 60 * 60_000),
        to: now,
      });
      expect(reported.amountMicrousd).toBeGreaterThanOrEqual(0n);
      expect(reported.scope).toMatch(/^ap-/);
    },
    liveTimeoutMs + 60_000,
  );

  it(
    "cancels a running T4 job and stops it on Modal",
    async () => {
      const created = await seedJob(["sh", "-c", "echo started; sleep 600"]);
      const running = await processUntil(
        created.id,
        (job) => job.state === "running" && Number(job.log_bytes) > 0,
      );
      const listed = await providers.modal!.listActiveJobs!();
      expect(listed).toContainEqual(
        expect.objectContaining({
          providerResourceId: running.provider_resource_id,
          metalGpuJobId: running.public_id,
        }),
      );
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
          reason: "cancelled_by_user",
        })}::jsonb)
      `;
      const cancelled = await processUntil(created.id, (job) => job.state === "cancelled");
      expect(cancelled.state_reason).toBe("cancelled_by_user");
      const status = await providers.modal!.status(String(running.provider_resource_id));
      expect(["terminated", "absent"]).toContain(status.state);
    },
    liveTimeoutMs + 60_000,
  );
});
