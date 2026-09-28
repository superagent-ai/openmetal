import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  autoTopupAttempts,
  autoTopupPolicies,
  gpuJobs,
  operations,
  outboxJobs,
  pricingVersions,
  sandboxes,
  usageCharges,
  type MetalDb,
} from "@openmetal/db";
import { ensureBillingAccount } from "./accounts.js";
import { recordBillingEvent } from "./events.js";
import { postLedgerTransaction, SYSTEM_ACTOR_ID } from "./ledger.js";
import { toMicrousd, USAGE_PRICING_CODE } from "./money.js";

const ACTIVE_SANDBOX_STATES = [
  "requested",
  "routing",
  "provisioning",
  "provision_unknown",
  "ready",
  "pausing",
  "paused",
  "resuming",
  "runtime_unknown",
] as const;
const TERMINAL_GPU_JOB_STATES = ["succeeded", "failed", "timed_out", "cancelled"] as const;

export async function organizationBalance(tx: MetalDb, organizationId: string): Promise<bigint> {
  const account = await ensureBillingAccount(tx, organizationId);
  return toMicrousd(account.balanceMicrousd);
}

export async function requirePositiveManagedBalance(
  tx: MetalDb,
  organizationId: string,
  managed: boolean,
) {
  if (!managed) return;
  const balance = await organizationBalance(tx, organizationId);
  if (balance <= 0n) {
    const error = new Error("insufficient credits");
    error.name = "InsufficientCreditsError";
    throw error;
  }
}

/**
 * Managed GPU jobs must be funded for this long at their estimated rate, on top
 * of the organization's other active managed GPU jobs, before they start.
 */
export const MANAGED_GPU_FUNDING_WINDOW_SECONDS = 900;

export type ManagedGpuFundingShortfall = {
  requiredMicrousd: bigint;
  balanceMicrousd: bigint;
  windowSeconds: number;
};

export async function managedGpuFundingShortfall(
  tx: MetalDb,
  organizationId: string,
  input: { hourlyMicrousd: bigint; excludeGpuJobId?: string },
): Promise<ManagedGpuFundingShortfall | null> {
  const [active] = await tx
    .select({
      hourly: sql<string>`coalesce(sum(${gpuJobs.estimatedHourlyMicrousd}), 0)::text`,
    })
    .from(gpuJobs)
    .where(
      and(
        eq(gpuJobs.organizationId, organizationId),
        eq(gpuJobs.billingMode, "managed"),
        inArray(gpuJobs.state, ["provisioning", "provision_unknown", "running", "cancelling"]),
        input.excludeGpuJobId ? ne(gpuJobs.id, input.excludeGpuJobId) : undefined,
      ),
    );
  const hourly = BigInt(active?.hourly ?? "0") + input.hourlyMicrousd;
  const window = BigInt(MANAGED_GPU_FUNDING_WINDOW_SECONDS);
  const requiredMicrousd = (hourly * window + 3_599n) / 3_600n;
  const balanceMicrousd = await organizationBalance(tx, organizationId);
  if (balanceMicrousd > 0n && balanceMicrousd >= requiredMicrousd) return null;
  return {
    requiredMicrousd,
    balanceMicrousd,
    windowSeconds: MANAGED_GPU_FUNDING_WINDOW_SECONDS,
  };
}

type UsageResource =
  { sandboxId: string; gpuJobId?: never } | { gpuJobId: string; sandboxId?: never };

export async function chargeUsageDelta(
  tx: MetalDb,
  input: {
    organizationId: string;
    projectId: string;
    snapshotId: string;
    currentCostMicrousd: bigint;
    measuredFrom?: Date | null;
    measuredThrough: Date;
    actorId: string;
  } & UsageResource,
) {
  await ensureBillingAccount(tx, input.organizationId);
  const resource = input.gpuJobId
    ? await tx
        .select({
          billingMode: gpuJobs.billingMode,
          customerChargedMicrousd: gpuJobs.customerChargedMicrousd,
        })
        .from(gpuJobs)
        .where(eq(gpuJobs.id, input.gpuJobId))
        .for("update")
        .then((rows) => rows[0])
    : await tx
        .select({
          billingMode: sandboxes.billingMode,
          customerChargedMicrousd: sandboxes.customerChargedMicrousd,
        })
        .from(sandboxes)
        .where(eq(sandboxes.id, input.sandboxId!))
        .for("update")
        .then((rows) => rows[0]);
  const [existingCharge] = await tx
    .select({ id: usageCharges.id })
    .from(usageCharges)
    .where(eq(usageCharges.snapshotId, input.snapshotId));
  if (existingCharge) {
    return { charged: false, balanceMicrousd: await organizationBalance(tx, input.organizationId) };
  }
  if (resource?.billingMode === "byok") {
    return { charged: false, balanceMicrousd: await organizationBalance(tx, input.organizationId) };
  }
  const previousChargedMicrousd = toMicrousd(resource?.customerChargedMicrousd);
  const delta = toMicrousd(input.currentCostMicrousd) - previousChargedMicrousd;
  if (delta === 0n) {
    return { charged: false, balanceMicrousd: await organizationBalance(tx, input.organizationId) };
  }
  const pricing = await tx
    .select({ id: pricingVersions.id })
    .from(pricingVersions)
    .where(eq(pricingVersions.code, USAGE_PRICING_CODE))
    .then((rows) => rows[0]);
  if (!pricing) {
    throw new Error("usage pricing version is not configured");
  }
  const kind = delta > 0n ? "usage_charge" : "usage_correction";
  const posted = await postLedgerTransaction(tx, {
    organizationId: input.organizationId,
    kind,
    referenceType: "usage_charge",
    referenceId: input.snapshotId,
    description: `Managed ${input.gpuJobId ? "GPU job" : "sandbox"} usage${delta > 0n ? "" : " correction"}`,
    actorId: input.actorId,
    lines: [
      { account: "customer_credits", amountMicrousd: -delta },
      { account: "platform_clearing", amountMicrousd: delta },
    ],
  });
  const inserted = await tx
    .insert(usageCharges)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      sandboxId: input.sandboxId ?? null,
      gpuJobId: input.gpuJobId ?? null,
      snapshotId: input.snapshotId,
      pricingVersionId: pricing.id,
      providerCostDeltaMicrousd: delta,
      customerChargeMicrousd: delta,
      measuredFrom: input.measuredFrom ?? null,
      measuredThrough: input.measuredThrough,
      ledgerTransactionId: posted.id,
    })
    .onConflictDoNothing()
    .returning({ id: usageCharges.id });
  if (!inserted[0]) {
    throw new Error("duplicate usage charge");
  }
  if (input.gpuJobId) {
    await tx
      .update(gpuJobs)
      .set({ customerChargedMicrousd: input.currentCostMicrousd, updatedAt: new Date() })
      .where(eq(gpuJobs.id, input.gpuJobId));
  } else {
    await tx
      .update(sandboxes)
      .set({ customerChargedMicrousd: input.currentCostMicrousd, updatedAt: new Date() })
      .where(eq(sandboxes.id, input.sandboxId!));
  }
  await recordBillingEvent(tx, {
    type: "billing.usage_charged",
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    data: {
      ...(input.gpuJobId ? { gpu_job_id: input.gpuJobId } : { sandbox_id: input.sandboxId }),
      snapshot_id: input.snapshotId,
      delta_microusd: delta.toString(),
      balance_microusd: posted.balanceMicrousd.toString(),
    },
  });
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "billing.auto_topup.evaluate",
      dedupeKey: `billing:auto-topup:${input.organizationId}:${input.snapshotId}`,
      payload: {
        job_type: "billing.auto_topup.evaluate",
        organization_id: input.organizationId,
        reason: "usage_charge",
      },
    })
    .onConflictDoNothing();
  if (posted.balanceMicrousd <= 0n) {
    const [policy] = await tx
      .select({ status: autoTopupPolicies.status, enabled: autoTopupPolicies.enabled })
      .from(autoTopupPolicies)
      .where(eq(autoTopupPolicies.organizationId, input.organizationId));
    if (!policy?.enabled || policy.status !== "active") {
      await tx
        .insert(outboxJobs)
        .values({
          jobType: "billing.spend_limit.enforce",
          dedupeKey: `billing:spend-limit:${input.organizationId}:${input.snapshotId}`,
          payload: {
            job_type: "billing.spend_limit.enforce",
            organization_id: input.organizationId,
            reason: "insufficient_credits",
          },
        })
        .onConflictDoNothing();
    }
  }
  return { charged: true, balanceMicrousd: posted.balanceMicrousd };
}

export async function enforceSpendLimit(tx: MetalDb, organizationId: string) {
  const account = await ensureBillingAccount(tx, organizationId);
  if (toMicrousd(account.balanceMicrousd) > 0n) {
    return { terminated: 0 };
  }
  const [pendingTopup] = await tx
    .select({ id: autoTopupAttempts.id })
    .from(autoTopupAttempts)
    .where(
      and(
        eq(autoTopupAttempts.organizationId, organizationId),
        eq(autoTopupAttempts.status, "pending"),
      ),
    );
  if (pendingTopup) {
    return { terminated: 0 };
  }
  const rows = await tx
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.organizationId, organizationId),
        eq(sandboxes.billingMode, "managed"),
        inArray(sandboxes.status, [...ACTIVE_SANDBOX_STATES]),
      ),
    );
  for (const sandbox of rows) {
    const operationId = crypto.randomUUID();
    await tx.insert(operations).values({
      id: operationId,
      publicId: `op_${operationId.replaceAll("-", "")}`,
      organizationId: sandbox.organizationId,
      projectId: sandbox.projectId,
      sandboxId: sandbox.id,
      type: "sandbox_destroy",
      state: "queued",
    });
    await tx
      .update(sandboxes)
      .set({ status: "stopping", updatedAt: new Date() })
      .where(eq(sandboxes.id, sandbox.id));
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "sandbox.destroy",
        dedupeKey: `sandbox:destroy:${sandbox.id}`,
        payload: {
          job_type: "sandbox.destroy",
          sandbox_id: sandbox.id,
          operation_id: operationId,
        },
      })
      .onConflictDoUpdate({
        target: outboxJobs.dedupeKey,
        set: {
          status: "pending",
          attemptCount: 0,
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          completedAt: null,
          updatedAt: new Date(),
          payload: {
            job_type: "sandbox.destroy",
            sandbox_id: sandbox.id,
            operation_id: operationId,
          },
        },
      });
  }
  const gpuJobRows = await tx
    .select({
      id: gpuJobs.id,
      organizationId: gpuJobs.organizationId,
      projectId: gpuJobs.projectId,
      state: gpuJobs.state,
    })
    .from(gpuJobs)
    .where(
      and(
        eq(gpuJobs.organizationId, organizationId),
        eq(gpuJobs.billingMode, "managed"),
        // A cancelling job already has a cancel operation and job queued.
        notInArray(gpuJobs.state, [...TERMINAL_GPU_JOB_STATES, "cancelling"]),
      ),
    )
    .for("update");
  for (const job of gpuJobRows) {
    const now = new Date();
    const operationId = crypto.randomUUID();
    await tx.insert(operations).values({
      id: operationId,
      publicId: `op_${operationId.replaceAll("-", "")}`,
      organizationId: job.organizationId,
      projectId: job.projectId,
      gpuJobId: job.id,
      type: "gpu_job_cancel",
      state: "queued",
    });
    await tx
      .update(gpuJobs)
      .set({
        state: "cancelling",
        cancelRequestedAt: now,
        cancelReason: "insufficient_credits",
        updatedAt: now,
      })
      .where(eq(gpuJobs.id, job.id));
    const payload = {
      job_type: "gpu_job.cancel",
      gpu_job_id: job.id,
      operation_id: operationId,
      reason: "insufficient_credits",
    };
    await tx
      .insert(outboxJobs)
      .values({ jobType: "gpu_job.cancel", dedupeKey: `gpu_job:cancel:${job.id}`, payload })
      .onConflictDoUpdate({
        target: outboxJobs.dedupeKey,
        set: {
          payload,
          status: "pending",
          attemptCount: 0,
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastError: null,
          completedAt: null,
          updatedAt: now,
        },
        setWhere: sql`${outboxJobs.status} <> 'leased'`,
      });
  }
  await recordBillingEvent(tx, {
    type: "billing.spend_limit_reached",
    organizationId,
    actorId: SYSTEM_ACTOR_ID,
    data: {
      balance_microusd: account.balanceMicrousd.toString(),
      terminated_count: rows.length + gpuJobRows.length,
      terminated_sandbox_count: rows.length,
      cancelled_gpu_job_count: gpuJobRows.length,
    },
  });
  return { terminated: rows.length + gpuJobRows.length };
}

export async function scheduleAutoTopupEvaluation(
  tx: MetalDb,
  organizationId: string,
  reason: string,
) {
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "billing.auto_topup.evaluate",
      dedupeKey: `billing:auto-topup:${organizationId}:${reason}:${Date.now()}`,
      payload: {
        job_type: "billing.auto_topup.evaluate",
        organization_id: organizationId,
        reason,
      },
    })
    .onConflictDoNothing();
}
