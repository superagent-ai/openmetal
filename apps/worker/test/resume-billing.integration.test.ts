import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";
import { CodeSandboxProvider } from "@openmetal/provider-codesandbox";
import { FakeSandboxProvider, loadTestEnv } from "@openmetal/testkit";
import { processOnce } from "../src/processor.js";
import { loadWorkerEnv } from "../src/env.js";

const env = loadTestEnv();

// Regression test for the billing-integrity vulnerability where resuming a
// CodeSandbox sandbox reset the provider cost timer (startedAt = now), so the
// resume-triggered cost sync saw a collapsed "cumulative" amount and posted a
// negative usage_correction that credited every prior charge back to the
// organization's balance.
describe("codesandbox resume billing baseline", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });

  beforeAll(async () => {
    expect(await database.ready()).toBe(true);
  });

  afterAll(async () => {
    await database.shutdown();
  });

  function workerEnv() {
    return loadWorkerEnv({
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      WORKER_ID: `resume-billing-${crypto.randomUUID().slice(0, 8)}`,
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_MS: "50",
      WORKER_BATCH_SIZE: "50",
      WORKER_MAX_ATTEMPTS: "2",
      WORKER_BASE_BACKOFF_MS: "10",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
  }

  async function processUntilJob(jobId: string, providers: Parameters<typeof processOnce>[3]) {
    const publisher = { publish: async () => undefined };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await processOnce(database.db, publisher, workerEnv(), providers);
      const [row] = await database.sql`
        select status from metal.outbox_jobs where id = ${jobId}
      `;
      if (row?.status === "succeeded") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`outbox job ${jobId} did not succeed`);
  }

  async function enqueueResume(sandboxId: string, orgId: string, projectId: string) {
    const operationId = crypto.randomUUID();
    await database.sql`
      insert into metal.operations (id, public_id, organization_id, project_id, sandbox_id, type, state)
      values (
        ${operationId},
        ${`op_${operationId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        ${sandboxId},
        'sandbox_resume',
        'queued'
      )
    `;
    await database.sql`
      insert into metal.operation_events (operation_id, sequence, type, data)
      values (${operationId}, 1, 'queued', '{}'::jsonb)
    `;
    const [job] = await database.sql`
      insert into metal.outbox_jobs (job_type, dedupe_key, payload, status)
      values (
        'sandbox.resume',
        ${`sandbox:resume:${sandboxId}:${operationId}`},
        ${JSON.stringify({
          job_type: "sandbox.resume",
          sandbox_id: sandboxId,
          operation_id: operationId,
        })}::jsonb,
        'pending'
      )
      returning id
    `;
    return String(job!.id);
  }

  it("carries the accrued cost baseline across pause/resume cycles so usage is never credited back", async () => {
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sandboxId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const providerResourceId = `csb-${sandboxId.replaceAll("-", "")}`;

    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Resume Billing Org', ${`rb-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId},
        ${`prj_${projectId.replaceAll("-", "")}`},
        ${orgId},
        'Resume Billing Project',
        ${`p-${projectId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into metal.billing_accounts (organization_id, balance_microusd)
      values (${orgId}, 10000000)
    `;
    // Sandbox as it stands after accruing $500 of managed usage and being
    // paused: provider-reported cost and customer charge are in sync.
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by,
        provider_resource_id, provider_organization_id, provider_metadata,
        provider_cost_microusd, customer_charged_microusd,
        billing_mode, ready_at, paused_at
      )
      values (
        ${sandboxId},
        ${`sbx_${sandboxId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        'codesandbox',
        'codesandbox',
        'paused',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${actorId},
        ${providerResourceId},
        'codesandbox-workspace',
        ${JSON.stringify({
          vmTier: "Medium",
          hourlyRateMicrousd: "80000000",
          startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        })}::jsonb,
        500000000,
        500000000,
        'managed',
        now() - interval '1 hour',
        now()
      )
    `;

    // Mimic CodeSandboxProvider.resume(): the provider restarts its cost timer
    // and returns fresh metadata without any cumulative context.
    const resumeProvider = new FakeSandboxProvider("codesandbox");
    resumeProvider.resume = async (resourceId: string) => ({
      providerResourceId: resourceId,
      providerOrganizationId: "codesandbox-workspace",
      providerMetadata: {
        vmTier: "Medium",
        startedAt: new Date().toISOString(),
        codesandbox: { start: { id: resourceId } },
      },
    });

    const resumeJobId = await enqueueResume(sandboxId, orgId, projectId);
    await processUntilJob(resumeJobId, { codesandbox: resumeProvider });

    const [resumed] = await database.sql`
      select status, provider_metadata
      from metal.sandboxes
      where id = ${sandboxId}
    `;
    expect(resumed?.status).toBe("ready");
    const resumedMetadata = resumed?.provider_metadata as Record<string, unknown>;
    // The accrued $500 is carried forward as the cumulative baseline, and the
    // original rate-card fields survive the provider's metadata reset.
    expect(resumedMetadata.costBaselineMicrousd).toBe("500000000");
    expect(resumedMetadata.hourlyRateMicrousd).toBe("80000000");

    // Run the resume-triggered cost sync with the real CodeSandbox cost
    // calculation (getCost is a pure rate-card computation, no network).
    const [syncJob] = await database.sql`
      select id from metal.outbox_jobs
      where job_type = 'sandbox.cost.sync' and payload->>'sandbox_id' = ${sandboxId}
      order by created_at asc
      limit 1
    `;
    expect(syncJob?.id).toBeTruthy();
    await database.sql`
      update metal.outbox_jobs set available_at = now() where id = ${syncJob!.id}
    `;
    const costProvider = new CodeSandboxProvider({
      apiKey: "test",
      creditRateMicrousd: 1_000_000n,
    });
    await processUntilJob(String(syncJob!.id), { codesandbox: costProvider });

    // One billed minute at the Medium rate: (80_000_000 + 30) / 60.
    const segmentMicrousd = (80_000_000n + 30n) / 60n;
    const [account] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    // The previously charged $500 is not credited back; only the post-resume
    // segment is charged.
    expect(BigInt(account!.balance_microusd)).toBe(10_000_000n - segmentMicrousd);
    const [corrections] = await database.sql`
      select count(*)::int as count from metal.ledger_transactions
      where organization_id = ${orgId} and kind = 'usage_correction'
    `;
    expect(corrections?.count).toBe(0);
    const [charged] = await database.sql`
      select customer_charged_microusd, provider_cost_microusd
      from metal.sandboxes
      where id = ${sandboxId}
    `;
    expect(BigInt(charged!.customer_charged_microusd)).toBe(500_000_000n + segmentMicrousd);
    expect(BigInt(charged!.provider_cost_microusd)).toBe(500_000_000n + segmentMicrousd);

    // A second pause/resume cycle must re-base onto the latest accrued cost,
    // not the stale baseline from the first resume.
    await database.sql`
      update metal.sandboxes set status = 'paused', paused_at = now() where id = ${sandboxId}
    `;
    const secondResumeJobId = await enqueueResume(sandboxId, orgId, projectId);
    await processUntilJob(secondResumeJobId, { codesandbox: resumeProvider });
    const [resumedAgain] = await database.sql`
      select provider_metadata from metal.sandboxes where id = ${sandboxId}
    `;
    expect((resumedAgain?.provider_metadata as Record<string, unknown>).costBaselineMicrousd).toBe(
      (500_000_000n + segmentMicrousd).toString(),
    );
  });

  it("captures usage accrued before the pause even when no cost sync has run yet", async () => {
    const orgId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sandboxId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const providerResourceId = `csb-${sandboxId.replaceAll("-", "")}`;

    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${orgId}, 'Resume Tail Org', ${`rt-${orgId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (
        ${projectId},
        ${`prj_${projectId.replaceAll("-", "")}`},
        ${orgId},
        'Resume Tail Project',
        ${`p-${projectId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into metal.billing_accounts (organization_id, balance_microusd)
      values (${orgId}, 100000000)
    `;
    // Paused after 30 minutes of runtime but never cost-synced
    // (provider_cost_microusd is null): the baseline must be recomputed from
    // the pre-resume metadata, not copied from the lagging column.
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by,
        provider_resource_id, provider_organization_id, provider_metadata,
        billing_mode, ready_at, paused_at
      )
      values (
        ${sandboxId},
        ${`sbx_${sandboxId.replaceAll("-", "")}`},
        ${orgId},
        ${projectId},
        'codesandbox',
        'codesandbox',
        'paused',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${actorId},
        ${providerResourceId},
        'codesandbox-workspace',
        ${JSON.stringify({
          vmTier: "Medium",
          hourlyRateMicrousd: "80000000",
          startedAt: "2026-09-18T10:00:00.000Z",
        })}::jsonb,
        'managed',
        '2026-09-18T10:00:00.000Z',
        '2026-09-18T10:30:00.000Z'
      )
    `;

    const realCost = new CodeSandboxProvider({
      apiKey: "test",
      creditRateMicrousd: 1_000_000n,
    });
    const resumeProvider = new FakeSandboxProvider("codesandbox");
    resumeProvider.resume = async (resourceId: string) => ({
      providerResourceId: resourceId,
      providerOrganizationId: "codesandbox-workspace",
      providerMetadata: {
        vmTier: "Medium",
        startedAt: new Date().toISOString(),
        codesandbox: { start: { id: resourceId } },
      },
    });
    resumeProvider.getCost = (input) => realCost.getCost(input);

    const resumeJobId = await enqueueResume(sandboxId, orgId, projectId);
    await processUntilJob(resumeJobId, { codesandbox: resumeProvider });

    // 30 accrued minutes at the Medium rate: (30 * 80_000_000 + 30) / 60.
    const accruedMicrousd = (30n * 80_000_000n + 30n) / 60n;
    const [resumed] = await database.sql`
      select status, provider_metadata from metal.sandboxes where id = ${sandboxId}
    `;
    expect(resumed?.status).toBe("ready");
    expect((resumed?.provider_metadata as Record<string, unknown>).costBaselineMicrousd).toBe(
      accruedMicrousd.toString(),
    );

    // The resume-triggered sync bills the whole accrued tail exactly once.
    const [syncJob] = await database.sql`
      select id from metal.outbox_jobs
      where job_type = 'sandbox.cost.sync' and payload->>'sandbox_id' = ${sandboxId}
      order by created_at asc
      limit 1
    `;
    expect(syncJob?.id).toBeTruthy();
    await database.sql`
      update metal.outbox_jobs set available_at = now() where id = ${syncJob!.id}
    `;
    await processUntilJob(String(syncJob!.id), { codesandbox: realCost });

    const segmentMicrousd = (80_000_000n + 30n) / 60n;
    const [account] = await database.sql`
      select balance_microusd from metal.billing_accounts where organization_id = ${orgId}
    `;
    expect(BigInt(account!.balance_microusd)).toBe(
      100_000_000n - accruedMicrousd - segmentMicrousd,
    );
    const [corrections] = await database.sql`
      select count(*)::int as count from metal.ledger_transactions
      where organization_id = ${orgId} and kind = 'usage_correction'
    `;
    expect(corrections?.count).toBe(0);
  });
});
