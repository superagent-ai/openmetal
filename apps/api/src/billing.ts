import {
  createCheckout,
  createPaymentMethodSetup,
  formatMicrousdUsd,
  getBillingSummary,
  handleStripeWebhook,
  MoneyError,
  parseUsdToMicrousd,
  quoteCreditPurchase,
  updateAutoTopupPolicy,
  type StripeGateway,
} from "@openmetal/billing";
import {
  BillingQuoteRequestSchema,
  CreateBillingCheckoutRequestSchema,
  UpdateAutoTopupRequestSchema,
  type OrganizationBilling,
} from "@openmetal/contracts";
import { type MetalDb } from "@openmetal/db";
import { requireMembership } from "./services.js";
import { ApiError } from "./errors.js";

function requireStripe(stripe: StripeGateway | null): StripeGateway {
  if (!stripe) {
    throw new ApiError(503, "service_unavailable", "billing is not configured");
  }
  return stripe;
}

export function serializeBillingSummary(
  summary: Awaited<ReturnType<typeof getBillingSummary>>,
  canManage: boolean,
): OrganizationBilling {
  const { account, policy, purchases, entries, autoTopupMonthCreditMicrousd } = summary;
  return {
    organization_id: account.organizationId,
    balance_microusd: account.balanceMicrousd.toString(),
    balance_usd: formatMicrousdUsd(account.balanceMicrousd),
    can_manage: canManage,
    payment_method: account.stripePaymentMethodId
      ? { brand: account.paymentMethodBrand, last4: account.paymentMethodLast4 }
      : null,
    auto_topup: {
      enabled: policy?.enabled ?? false,
      status: policy?.status ?? "disabled",
      threshold_usd: formatMicrousdUsd(policy?.thresholdMicrousd ?? 10_000_000n),
      refill_usd: formatMicrousdUsd(policy?.refillMicrousd ?? 50_000_000n),
      monthly_cap_usd: formatMicrousdUsd(policy?.monthlyCapMicrousd ?? 500_000_000n),
      month_credited_usd: formatMicrousdUsd(autoTopupMonthCreditMicrousd),
      paused_reason: policy?.pausedReason ?? null,
    },
    purchases: purchases.map((purchase) => ({
      id: purchase.id,
      source: purchase.source,
      status: purchase.status,
      credit_usd: formatMicrousdUsd(purchase.creditMicrousd),
      fee_usd: formatMicrousdUsd(purchase.feeMicrousd),
      total_usd: formatMicrousdUsd(purchase.totalMicrousd),
      created_at: purchase.createdAt.toISOString(),
      paid_at: purchase.paidAt?.toISOString() ?? null,
    })),
    ledger: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      amount_microusd: entry.amountMicrousd.toString(),
      amount_usd: formatMicrousdUsd(entry.amountMicrousd),
      description: entry.description,
      created_at: entry.createdAt.toISOString(),
    })),
  };
}

export async function readOrganizationBilling(
  db: MetalDb,
  input: { userId: string; organizationId: string },
) {
  const membership = await requireMembership(db, input.userId, input.organizationId);
  const summary = await getBillingSummary(db, input.organizationId);
  return serializeBillingSummary(
    summary,
    membership.role === "owner" || membership.role === "admin",
  );
}

export function quoteOrganizationPurchase(amountUsd: string) {
  const parsed = BillingQuoteRequestSchema.safeParse({ amount_usd: amountUsd });
  if (!parsed.success) {
    throw new ApiError(422, "validation_error", "invalid purchase amount");
  }
  try {
    const quote = quoteCreditPurchase(parseUsdToMicrousd(parsed.data.amount_usd));
    return {
      amount_usd: parsed.data.amount_usd,
      credit_microusd: quote.credit_microusd.toString(),
      fee_microusd: quote.fee_microusd.toString(),
      total_microusd: quote.total_microusd.toString(),
      credit_usd: formatMicrousdUsd(quote.credit_microusd),
      fee_usd: formatMicrousdUsd(quote.fee_microusd),
      total_usd: formatMicrousdUsd(quote.total_microusd),
      fee_rate: "0.055" as const,
      min_fee_usd: "0.80" as const,
    };
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new ApiError(422, "validation_error", error.message);
    }
    throw error;
  }
}

export async function startOrganizationCheckout(
  db: MetalDb,
  stripe: StripeGateway | null,
  input: {
    userId: string;
    organizationId: string;
    body: unknown;
    siteUrl: string;
  },
) {
  const gateway = requireStripe(stripe);
  await requireMembership(db, input.userId, input.organizationId, ["owner", "admin"]);
  const parsed = CreateBillingCheckoutRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    throw new ApiError(422, "validation_error", "invalid checkout payload");
  }
  try {
    return await createCheckout(db, gateway, {
      organizationId: input.organizationId,
      actorId: input.userId,
      amountUsd: parsed.data.amount_usd,
      siteUrl: input.siteUrl,
    });
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new ApiError(422, "validation_error", error.message);
    }
    throw error;
  }
}

export async function startPaymentMethodSetup(
  db: MetalDb,
  stripe: StripeGateway | null,
  input: { userId: string; organizationId: string; siteUrl: string },
) {
  const gateway = requireStripe(stripe);
  await requireMembership(db, input.userId, input.organizationId, ["owner", "admin"]);
  const session = await createPaymentMethodSetup(db, gateway, {
    organizationId: input.organizationId,
    siteUrl: input.siteUrl,
  });
  return { checkout_url: session.url };
}

export async function saveAutoTopupPolicy(
  db: MetalDb,
  input: { userId: string; organizationId: string; body: unknown },
) {
  const membership = await requireMembership(db, input.userId, input.organizationId, [
    "owner",
    "admin",
  ]);
  const parsed = UpdateAutoTopupRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    throw new ApiError(422, "validation_error", "invalid automatic top up payload");
  }
  try {
    await updateAutoTopupPolicy(db, {
      organizationId: input.organizationId,
      actorId: input.userId,
      enabled: parsed.data.enabled,
      thresholdMicrousd: parseUsdToMicrousd(parsed.data.threshold_usd),
      refillMicrousd: parseUsdToMicrousd(parsed.data.refill_usd),
      monthlyCapMicrousd: parseUsdToMicrousd(parsed.data.monthly_cap_usd),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "PaymentMethodRequiredError") {
      throw new ApiError(409, "conflict", error.message);
    }
    if (error instanceof MoneyError || error instanceof Error) {
      throw new ApiError(422, "validation_error", error.message);
    }
    throw error;
  }
  const summary = await getBillingSummary(db, input.organizationId);
  return serializeBillingSummary(
    summary,
    membership.role === "owner" || membership.role === "admin",
  );
}

export async function receiveStripeWebhook(
  db: MetalDb,
  stripe: StripeGateway | null,
  input: { payload: Buffer | string; signature: string | undefined; secret: string | undefined },
) {
  const gateway = requireStripe(stripe);
  if (!input.secret) {
    throw new ApiError(503, "service_unavailable", "billing is not configured");
  }
  if (!input.signature) {
    throw new ApiError(400, "validation_error", "missing stripe signature");
  }
  try {
    await handleStripeWebhook(db, gateway, {
      payload: input.payload,
      signature: input.signature,
      secret: input.secret,
    });
  } catch (error) {
    if (error instanceof Error && /signature/i.test(error.message)) {
      throw new ApiError(400, "validation_error", "invalid stripe signature");
    }
    if (
      error instanceof Error &&
      /mismatch|missing purchase metadata|credit purchase not found/i.test(error.message)
    ) {
      throw new ApiError(400, "validation_error", error.message);
    }
    throw error;
  }
  return { received: true };
}
