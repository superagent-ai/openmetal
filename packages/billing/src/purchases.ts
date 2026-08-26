import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  autoTopupAttempts,
  autoTopupPolicies,
  billingAccounts,
  creditPurchases,
  ledgerEntries,
  ledgerTransactions,
  outboxJobs,
  pricingVersions,
  stripeEvents,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import { ensureBillingAccount, getOrganizationName, getOrganizationSlug } from "./accounts.js";
import { recordBillingEvent } from "./events.js";
import { postLedgerTransaction } from "./ledger.js";
import {
  formatMicrousdUsd,
  MICROUSD_PER_CENT,
  parseUsdToMicrousd,
  PURCHASE_FEE_CODE,
  quoteCreditPurchase,
  toMicrousd,
} from "./money.js";
import type { StripeGateway, StripePaymentMethodSnapshot } from "./stripe.js";

export async function getPricingVersionId(tx: MetalDb, code: string): Promise<string> {
  const row = await tx
    .select({ id: pricingVersions.id })
    .from(pricingVersions)
    .where(eq(pricingVersions.code, code))
    .then((rows) => rows[0]);
  if (!row) {
    throw new Error(`pricing version ${code} is not configured`);
  }
  return row.id;
}

export async function grantCredits(
  tx: MetalDb,
  input: {
    organizationId: string;
    creditMicrousd: bigint;
    actorId: string;
    description?: string;
  },
) {
  await ensureBillingAccount(tx, input.organizationId);
  const pricingVersionId = await getPricingVersionId(tx, PURCHASE_FEE_CODE);
  const [purchase] = await tx
    .insert(creditPurchases)
    .values({
      organizationId: input.organizationId,
      source: "admin_grant",
      status: "paid",
      creditMicrousd: input.creditMicrousd,
      feeMicrousd: 0n,
      totalMicrousd: input.creditMicrousd,
      pricingVersionId,
      actorId: input.actorId,
      paidAt: new Date(),
    })
    .returning();
  if (!purchase) {
    throw new Error("failed to grant credits");
  }
  const posted = await postLedgerTransaction(tx, {
    organizationId: input.organizationId,
    kind: "deposit",
    referenceType: "credit_purchase",
    referenceId: purchase.id,
    description: input.description ?? `Credit grant ${formatMicrousdUsd(input.creditMicrousd)} USD`,
    actorId: input.actorId,
    lines: [
      { account: "customer_credits", amountMicrousd: input.creditMicrousd },
      { account: "platform_clearing", amountMicrousd: -input.creditMicrousd },
    ],
  });
  return { purchase, balanceMicrousd: posted.balanceMicrousd };
}

async function ensureStripeCustomer(
  db: MetalDb,
  stripe: StripeGateway,
  organizationId: string,
): Promise<{ customerId: string; organizationName: string; organizationSlug: string }> {
  const snapshot = await withTransaction(db, async (tx) => {
    const account = await ensureBillingAccount(tx, organizationId);
    return {
      customerId: account.stripeCustomerId,
      organizationName: await getOrganizationName(tx, organizationId),
      organizationSlug: await getOrganizationSlug(tx, organizationId),
    };
  });
  if (snapshot.customerId) {
    return { ...snapshot, customerId: snapshot.customerId };
  }

  const customer = await stripe.createCustomer({
    organizationId,
    name: snapshot.organizationName,
  });
  const customerId = await withTransaction(db, async (tx) => {
    const account = await ensureBillingAccount(tx, organizationId);
    if (account.stripeCustomerId) {
      return account.stripeCustomerId;
    }
    await tx
      .update(billingAccounts)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(
        and(
          eq(billingAccounts.organizationId, organizationId),
          isNull(billingAccounts.stripeCustomerId),
        ),
      );
    return customer.id;
  });
  return { ...snapshot, customerId };
}

export async function saveCustomerPaymentMethod(
  tx: MetalDb,
  stripe: StripeGateway,
  organizationId: string,
  customerId: string,
  paymentMethodId: string | null,
) {
  if (!paymentMethodId) return;
  const method: StripePaymentMethodSnapshot = await stripe.retrievePaymentMethod(paymentMethodId);
  await tx
    .update(billingAccounts)
    .set({
      stripeCustomerId: customerId,
      stripePaymentMethodId: method.id,
      paymentMethodBrand: method.brand,
      paymentMethodLast4: method.last4,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.organizationId, organizationId));
}

export async function createCheckout(
  db: MetalDb,
  stripe: StripeGateway,
  input: {
    organizationId: string;
    actorId: string;
    amountUsd: string;
    siteUrl: string;
  },
) {
  const quote = quoteCreditPurchase(parseUsdToMicrousd(input.amountUsd));
  const { customerId, organizationSlug } = await ensureStripeCustomer(
    db,
    stripe,
    input.organizationId,
  );
  const purchase = await withTransaction(db, async (tx) => {
    await ensureBillingAccount(tx, input.organizationId);
    const pricingVersionId = await getPricingVersionId(tx, PURCHASE_FEE_CODE);
    const [row] = await tx
      .insert(creditPurchases)
      .values({
        organizationId: input.organizationId,
        source: "checkout",
        status: "pending",
        creditMicrousd: quote.credit_microusd,
        feeMicrousd: quote.fee_microusd,
        totalMicrousd: quote.total_microusd,
        pricingVersionId,
        stripeCustomerId: customerId,
        actorId: input.actorId,
      })
      .returning();
    if (!row) {
      throw new Error("failed to create credit purchase");
    }
    return row;
  });
  const origin = input.siteUrl.replace(/\/$/, "");
  const session = await stripe.createCheckoutSession({
    customerId,
    organizationId: input.organizationId,
    organizationSlug,
    purchaseId: purchase.id,
    creditMicrousd: quote.credit_microusd,
    feeMicrousd: quote.fee_microusd,
    totalMicrousd: quote.total_microusd,
    successUrl: `${origin}/dashboard/${organizationSlug}/billing?checkout=success`,
    cancelUrl: `${origin}/dashboard/${organizationSlug}/billing?checkout=cancel`,
  });
  await withTransaction(db, async (tx) => {
    await tx
      .update(creditPurchases)
      .set({ stripeCheckoutSessionId: session.id })
      .where(eq(creditPurchases.id, purchase.id));
  });
  return {
    checkout_url: session.url,
    purchase_id: purchase.id,
    credit_microusd: quote.credit_microusd.toString(),
    fee_microusd: quote.fee_microusd.toString(),
    total_microusd: quote.total_microusd.toString(),
  };
}

export async function createPaymentMethodSetup(
  db: MetalDb,
  stripe: StripeGateway,
  input: { organizationId: string; siteUrl: string },
) {
  const { customerId, organizationSlug } = await ensureStripeCustomer(
    db,
    stripe,
    input.organizationId,
  );
  const origin = input.siteUrl.replace(/\/$/, "");
  return stripe.createSetupCheckoutSession({
    customerId,
    organizationId: input.organizationId,
    successUrl: `${origin}/dashboard/${organizationSlug}/billing?setup=success`,
    cancelUrl: `${origin}/dashboard/${organizationSlug}/billing?setup=cancel`,
  });
}

async function creditPaidPurchase(
  tx: MetalDb,
  purchaseId: string,
  stripeIds: { customerId?: string | null; paymentIntentId?: string | null },
) {
  const purchase = await tx
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.id, purchaseId))
    .then((rows) => rows[0]);
  if (!purchase) {
    throw new Error("credit purchase not found");
  }
  await ensureBillingAccount(tx, purchase.organizationId);
  const [locked] = await tx
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.id, purchase.id));
  if (!locked || locked.status === "paid") {
    return locked ?? purchase;
  }
  const [updated] = await tx
    .update(creditPurchases)
    .set({
      status: "paid",
      paidAt: new Date(),
      stripeCustomerId: stripeIds.customerId ?? locked.stripeCustomerId,
      stripePaymentIntentId: stripeIds.paymentIntentId ?? locked.stripePaymentIntentId,
    })
    .where(and(eq(creditPurchases.id, locked.id), eq(creditPurchases.status, "pending")))
    .returning({ id: creditPurchases.id });
  if (!updated) {
    return locked;
  }
  const posted = await postLedgerTransaction(tx, {
    organizationId: locked.organizationId,
    kind: "deposit",
    referenceType: "credit_purchase",
    referenceId: locked.id,
    description: `Credit purchase ${formatMicrousdUsd(locked.creditMicrousd)} USD`,
    actorId: locked.actorId,
    lines: [
      { account: "customer_credits", amountMicrousd: BigInt(purchase.creditMicrousd) },
      { account: "platform_clearing", amountMicrousd: -BigInt(purchase.creditMicrousd) },
    ],
  });
  await recordBillingEvent(tx, {
    type: "billing.credits_purchased",
    organizationId: purchase.organizationId,
    actorId: purchase.actorId,
    data: {
      purchase_id: purchase.id,
      credit_microusd: purchase.creditMicrousd.toString(),
      fee_microusd: purchase.feeMicrousd.toString(),
      balance_microusd: posted.balanceMicrousd.toString(),
      source: purchase.source,
    },
  });
  return purchase;
}

export async function fulfillCheckoutPayment(
  tx: MetalDb,
  stripe: StripeGateway,
  session: {
    id: string;
    paymentStatus: string | null;
    customerId: string | null;
    paymentIntentId: string | null;
    paymentMethodId: string | null;
    amountTotal: number | null;
    currency: string | null;
    metadata: Record<string, string>;
  },
) {
  if (session.paymentStatus && session.paymentStatus !== "paid") {
    return { credited: false };
  }
  const purchaseId = session.metadata.purchase_id;
  if (!purchaseId) {
    throw new Error("checkout session is missing purchase metadata");
  }
  const purchase = await tx
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.id, purchaseId))
    .then((rows) => rows[0]);
  if (!purchase) {
    throw new Error("credit purchase not found");
  }
  if (session.currency && session.currency !== "usd") {
    throw new Error("checkout session currency mismatch");
  }
  if (
    session.amountTotal != null &&
    BigInt(session.amountTotal) * MICROUSD_PER_CENT !== toMicrousd(purchase.totalMicrousd)
  ) {
    throw new Error("checkout session amount mismatch");
  }
  if (
    session.customerId &&
    purchase.stripeCustomerId &&
    session.customerId !== purchase.stripeCustomerId
  ) {
    throw new Error("checkout session customer mismatch");
  }
  await creditPaidPurchase(tx, purchase.id, {
    customerId: session.customerId,
    paymentIntentId: session.paymentIntentId,
  });
  await saveCustomerPaymentMethod(
    tx,
    stripe,
    purchase.organizationId,
    session.customerId ?? purchase.stripeCustomerId ?? "",
    session.paymentMethodId,
  );
  return { credited: true, organizationId: purchase.organizationId };
}

export async function fulfillPaymentIntent(
  tx: MetalDb,
  stripe: StripeGateway,
  intent: {
    id: string;
    status: string;
    customerId: string | null;
    paymentMethodId: string | null;
    amount: number;
    currency: string;
    metadata: Record<string, string>;
  },
) {
  if (intent.status !== "succeeded") {
    return { credited: false };
  }
  const purchaseId = intent.metadata.purchase_id;
  if (!purchaseId) {
    return { credited: false };
  }
  const purchase = await tx
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.id, purchaseId))
    .then((rows) => rows[0]);
  if (!purchase) {
    throw new Error("credit purchase not found");
  }
  if (intent.currency !== "usd") {
    throw new Error("payment intent currency mismatch");
  }
  if (BigInt(intent.amount) * MICROUSD_PER_CENT !== toMicrousd(purchase.totalMicrousd)) {
    throw new Error("payment intent amount mismatch");
  }
  await creditPaidPurchase(tx, purchase.id, {
    customerId: intent.customerId,
    paymentIntentId: intent.id,
  });
  await saveCustomerPaymentMethod(
    tx,
    stripe,
    purchase.organizationId,
    intent.customerId ?? purchase.stripeCustomerId ?? "",
    intent.paymentMethodId,
  );
  if (intent.metadata.attempt_id) {
    await tx
      .update(autoTopupAttempts)
      .set({
        status: "succeeded",
        stripePaymentIntentId: intent.id,
        completedAt: new Date(),
      })
      .where(eq(autoTopupAttempts.id, intent.metadata.attempt_id));
    await tx
      .update(autoTopupPolicies)
      .set({ status: "active", pausedReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(autoTopupPolicies.organizationId, purchase.organizationId),
          eq(autoTopupPolicies.enabled, true),
        ),
      );
  }
  return { credited: true, organizationId: purchase.organizationId };
}

export async function markPaymentFailed(
  tx: MetalDb,
  input: {
    purchaseId?: string;
    attemptId?: string;
    paymentIntentId?: string;
    errorCode?: string;
    errorMessage?: string;
    requiresAction?: boolean;
  },
) {
  let organizationId: string | undefined;
  if (input.purchaseId) {
    const [purchase] = await tx
      .update(creditPurchases)
      .set({
        status: input.requiresAction ? "requires_action" : "failed",
        stripePaymentIntentId: input.paymentIntentId,
      })
      .where(eq(creditPurchases.id, input.purchaseId))
      .returning({
        organizationId: creditPurchases.organizationId,
        actorId: creditPurchases.actorId,
      });
    organizationId = purchase?.organizationId;
    if (purchase) {
      await recordBillingEvent(tx, {
        type: "billing.auto_topup_failed",
        organizationId: purchase.organizationId,
        actorId: purchase.actorId,
        data: {
          purchase_id: input.purchaseId,
          error_code: input.errorCode ?? "payment_failed",
          requires_action: Boolean(input.requiresAction),
        },
      });
    }
  }
  if (input.attemptId) {
    const [attempt] = await tx
      .update(autoTopupAttempts)
      .set({
        status: input.requiresAction ? "requires_action" : "failed",
        stripePaymentIntentId: input.paymentIntentId,
        errorCode: input.errorCode ?? "payment_failed",
        errorMessage: input.errorMessage ?? "automatic top up failed",
        completedAt: new Date(),
      })
      .where(eq(autoTopupAttempts.id, input.attemptId))
      .returning({ organizationId: autoTopupAttempts.organizationId });
    organizationId = organizationId ?? attempt?.organizationId;
  }
  if (organizationId) {
    await tx
      .update(autoTopupPolicies)
      .set({
        status: "paused",
        pausedReason: input.requiresAction ? "requires_action" : "payment_failed",
        updatedAt: new Date(),
      })
      .where(eq(autoTopupPolicies.organizationId, organizationId));
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "billing.spend_limit.enforce",
        dedupeKey: `billing:spend-limit:${organizationId}:${input.purchaseId ?? input.attemptId}`,
        payload: {
          job_type: "billing.spend_limit.enforce",
          organization_id: organizationId,
          reason: "insufficient_credits",
        },
      })
      .onConflictDoNothing();
  }
}

export async function recordStripeEvent(
  tx: MetalDb,
  eventId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const inserted = await tx
    .insert(stripeEvents)
    .values({ eventId, type, payload })
    .onConflictDoNothing()
    .returning({ eventId: stripeEvents.eventId });
  return Boolean(inserted[0]);
}

export async function getBillingSummary(tx: MetalDb, organizationId: string) {
  const account = await ensureBillingAccount(tx, organizationId);
  const [policy] = await tx
    .select()
    .from(autoTopupPolicies)
    .where(eq(autoTopupPolicies.organizationId, organizationId));
  const purchases = await tx
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.organizationId, organizationId))
    .orderBy(desc(creditPurchases.createdAt))
    .limit(20);
  const entries = await tx
    .select({
      id: ledgerEntries.id,
      account: ledgerEntries.account,
      amountMicrousd: ledgerEntries.amountMicrousd,
      createdAt: ledgerEntries.createdAt,
      kind: ledgerTransactions.kind,
      description: ledgerTransactions.description,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerEntries.organizationId, organizationId),
        eq(ledgerEntries.account, "customer_credits"),
      ),
    )
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(25);

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
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
        gte(creditPurchases.paidAt, monthStart),
      ),
    );

  return {
    account,
    policy,
    purchases,
    entries,
    autoTopupMonthCreditMicrousd: toMicrousd(total),
  };
}
