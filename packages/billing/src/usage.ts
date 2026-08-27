import { and, eq, inArray, sql } from "drizzle-orm";
import {
  autoTopupAttempts,
  autoTopupPolicies,
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

export async function chargeUsageDelta(
  tx: MetalDb,
  input: {
    organizationId: string;
    projectId: string;
    sandboxId: string;
    snapshotId: string;
    currentCostMicrousd: bigint;
    measuredFrom?: Date | null;
    measuredThrough: Date;
    actorId: string;
  },
) {
  await ensureBillingAccount(tx, input.organizationId);
  await tx.execute(sql`select id from metal.sandboxes where id = ${input.sandboxId} for update`);
  const [existingCharge] = await tx
    .select({ id: usageCharges.id })
    .from(usageCharges)
    .where(eq(usageCharges.snapshotId, input.snapshotId));
  if (existingCharge) {
    return { charged: false, balanceMicrousd: await organizationBalance(tx, input.organizationId) };
  }
  const [sandbox] = await tx
    .select({ customerChargedMicrousd: sandboxes.customerChargedMicrousd })
    .from(sandboxes)
    .where(eq(sandboxes.id, input.sandboxId));
  const previousChargedMicrousd = toMicrousd(sandbox?.customerChargedMicrousd);
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
    description: delta > 0n ? "Managed sandbox usage" : "Managed sandbox usage correction",
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
      sandboxId: input.sandboxId,
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
  await tx
    .update(sandboxes)
    .set({
      customerChargedMicrousd: input.currentCostMicrousd,
      updatedAt: new Date(),
    })
    .where(eq(sandboxes.id, input.sandboxId));
  await recordBillingEvent(tx, {
    type: "billing.usage_charged",
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    data: {
      sandbox_id: input.sandboxId,
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
  await recordBillingEvent(tx, {
    type: "billing.spend_limit_reached",
    organizationId,
    actorId: SYSTEM_ACTOR_ID,
    data: {
      balance_microusd: account.balanceMicrousd.toString(),
      terminated_count: rows.length,
    },
  });
  return { terminated: rows.length };
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
