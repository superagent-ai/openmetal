import { and, eq, gte, sql } from "drizzle-orm";
import { autoTopupAttempts, autoTopupPolicies, creditPurchases, type MetalDb } from "@openmetal/db";
import { ensureBillingAccount } from "./accounts.js";
import { getPricingVersionId, markPaymentFailed } from "./purchases.js";
import { SYSTEM_ACTOR_ID } from "./ledger.js";
import {
  MICROUSD_PER_CENT,
  PURCHASE_FEE_CODE,
  quoteCreditPurchase,
  utcMonthStart,
  toMicrousd,
} from "./money.js";
import type { StripeGateway } from "./stripe.js";

export async function updateAutoTopupPolicy(
  tx: MetalDb,
  input: {
    organizationId: string;
    actorId: string;
    enabled: boolean;
    thresholdMicrousd: bigint;
    refillMicrousd: bigint;
    monthlyCapMicrousd: bigint;
  },
) {
  const account = await ensureBillingAccount(tx, input.organizationId);
  quoteCreditPurchase(toMicrousd(input.refillMicrousd));
  if (toMicrousd(input.thresholdMicrousd) <= 0n) {
    throw new Error("threshold must be greater than zero");
  }
  if (toMicrousd(input.monthlyCapMicrousd) < toMicrousd(input.refillMicrousd)) {
    throw new Error("monthly cap must cover the refill amount");
  }
  if (input.enabled && !account.stripePaymentMethodId) {
    const error = new Error("a saved payment method is required before enabling automatic top ups");
    error.name = "PaymentMethodRequiredError";
    throw error;
  }
  const status = input.enabled ? "active" : "disabled";
  const [policy] = await tx
    .insert(autoTopupPolicies)
    .values({
      organizationId: input.organizationId,
      enabled: input.enabled,
      status,
      thresholdMicrousd: input.thresholdMicrousd,
      refillMicrousd: input.refillMicrousd,
      monthlyCapMicrousd: input.monthlyCapMicrousd,
      pausedReason: null,
      updatedBy: input.actorId,
    })
    .onConflictDoUpdate({
      target: autoTopupPolicies.organizationId,
      set: {
        enabled: input.enabled,
        status,
        thresholdMicrousd: input.thresholdMicrousd,
        refillMicrousd: input.refillMicrousd,
        monthlyCapMicrousd: input.monthlyCapMicrousd,
        pausedReason: null,
        updatedBy: input.actorId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return { policy, account };
}

export async function evaluateAutoTopup(
  tx: MetalDb,
  stripe: StripeGateway,
  organizationId: string,
): Promise<{ started: boolean; reason?: string }> {
  const account = await ensureBillingAccount(tx, organizationId);
  const [policy] = await tx
    .select()
    .from(autoTopupPolicies)
    .where(eq(autoTopupPolicies.organizationId, organizationId));
  if (!policy?.enabled || policy.status !== "active") {
    return { started: false, reason: "inactive" };
  }
  if (toMicrousd(account.balanceMicrousd) > toMicrousd(policy.thresholdMicrousd)) {
    return { started: false, reason: "above_threshold" };
  }
  if (!account.stripeCustomerId || !account.stripePaymentMethodId) {
    return { started: false, reason: "missing_payment_method" };
  }
  const [pending] = await tx
    .select({ id: autoTopupAttempts.id })
    .from(autoTopupAttempts)
    .where(
      and(
        eq(autoTopupAttempts.organizationId, organizationId),
        eq(autoTopupAttempts.status, "pending"),
      ),
    );
  if (pending) {
    return { started: false, reason: "pending_attempt" };
  }
  const windowStart = utcMonthStart();
  const [{ total } = { total: 0n }] = await tx
    .select({
      total: sql<bigint>`coalesce(sum(${creditPurchases.creditMicrousd}), 0)`,
    })
    .from(creditPurchases)
    .where(
      and(
        eq(creditPurchases.organizationId, organizationId),
        eq(creditPurchases.source, "auto_topup"),
        eq(creditPurchases.status, "paid"),
        gte(creditPurchases.paidAt, windowStart),
      ),
    );
  const monthUsed = toMicrousd(total);
  if (monthUsed + toMicrousd(policy.refillMicrousd) > toMicrousd(policy.monthlyCapMicrousd)) {
    await tx
      .update(autoTopupPolicies)
      .set({ status: "paused", pausedReason: "monthly_cap", updatedAt: new Date() })
      .where(eq(autoTopupPolicies.organizationId, organizationId));
    return { started: false, reason: "monthly_cap" };
  }
  const quote = quoteCreditPurchase(toMicrousd(policy.refillMicrousd));
  const pricingVersionId = await getPricingVersionId(tx, PURCHASE_FEE_CODE);
  const [purchase] = await tx
    .insert(creditPurchases)
    .values({
      organizationId,
      source: "auto_topup",
      status: "pending",
      creditMicrousd: quote.credit_microusd,
      feeMicrousd: quote.fee_microusd,
      totalMicrousd: quote.total_microusd,
      pricingVersionId,
      stripeCustomerId: account.stripeCustomerId,
      actorId: policy.updatedBy ?? SYSTEM_ACTOR_ID,
    })
    .returning();
  if (!purchase) {
    throw new Error("failed to create automatic top up purchase");
  }
  const [attempt] = await tx
    .insert(autoTopupAttempts)
    .values({
      organizationId,
      purchaseId: purchase.id,
      status: "pending",
      windowStart,
      creditMicrousd: quote.credit_microusd,
      feeMicrousd: quote.fee_microusd,
      totalMicrousd: quote.total_microusd,
    })
    .returning();
  if (!attempt) {
    throw new Error("failed to create automatic top up attempt");
  }
  const intent = await stripe.createOffSessionPaymentIntent({
    customerId: account.stripeCustomerId,
    paymentMethodId: account.stripePaymentMethodId,
    organizationId,
    purchaseId: purchase.id,
    attemptId: attempt.id,
    creditMicrousd: quote.credit_microusd,
    feeMicrousd: quote.fee_microusd,
    totalCents: Number(quote.total_microusd / MICROUSD_PER_CENT),
  });
  await tx
    .update(creditPurchases)
    .set({ stripePaymentIntentId: intent.id })
    .where(eq(creditPurchases.id, purchase.id));
  await tx
    .update(autoTopupAttempts)
    .set({ stripePaymentIntentId: intent.id })
    .where(eq(autoTopupAttempts.id, attempt.id));
  if (intent.status === "requires_action" || intent.status === "requires_payment_method") {
    await markPaymentFailed(tx, {
      purchaseId: purchase.id,
      attemptId: attempt.id,
      paymentIntentId: intent.id,
      requiresAction: intent.status === "requires_action",
      errorCode: intent.status,
    });
    return { started: false, reason: intent.status };
  }
  return { started: true };
}
