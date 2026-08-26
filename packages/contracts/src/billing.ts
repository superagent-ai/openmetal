import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";

export const UsdAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,2})?$/, "amount must be a USD value with up to two decimal places");

export const BillingQuoteRequestSchema = z.object({
  amount_usd: UsdAmountSchema,
});
export type BillingQuoteRequest = z.infer<typeof BillingQuoteRequestSchema>;

export const BillingQuoteSchema = z.object({
  amount_usd: UsdAmountSchema,
  credit_microusd: z.string(),
  fee_microusd: z.string(),
  total_microusd: z.string(),
  credit_usd: z.string(),
  fee_usd: z.string(),
  total_usd: z.string(),
  fee_rate: z.literal("0.055"),
  min_fee_usd: z.literal("0.80"),
});
export type BillingQuote = z.infer<typeof BillingQuoteSchema>;

export const CreateBillingCheckoutRequestSchema = z.object({
  amount_usd: UsdAmountSchema,
});
export type CreateBillingCheckoutRequest = z.infer<typeof CreateBillingCheckoutRequestSchema>;

export const BillingCheckoutResponseSchema = z.object({
  checkout_url: z.url(),
  purchase_id: OpaqueIdSchema,
  credit_microusd: z.string(),
  fee_microusd: z.string(),
  total_microusd: z.string(),
});
export type BillingCheckoutResponse = z.infer<typeof BillingCheckoutResponseSchema>;

export const UpdateAutoTopupRequestSchema = z.object({
  enabled: z.boolean(),
  threshold_usd: UsdAmountSchema,
  refill_usd: UsdAmountSchema,
  monthly_cap_usd: UsdAmountSchema,
});
export type UpdateAutoTopupRequest = z.infer<typeof UpdateAutoTopupRequestSchema>;

export const AutoTopupPolicySchema = z.object({
  enabled: z.boolean(),
  status: z.enum(["disabled", "active", "paused"]),
  threshold_usd: z.string(),
  refill_usd: z.string(),
  monthly_cap_usd: z.string(),
  month_credited_usd: z.string(),
  paused_reason: z.string().nullable(),
});
export type AutoTopupPolicy = z.infer<typeof AutoTopupPolicySchema>;

export const BillingPaymentMethodSchema = z.object({
  brand: z.string().nullable(),
  last4: z.string().nullable(),
});
export type BillingPaymentMethod = z.infer<typeof BillingPaymentMethodSchema>;

export const BillingLedgerEntrySchema = z.object({
  id: OpaqueIdSchema,
  kind: z.enum(["deposit", "usage_charge", "usage_correction", "adjustment"]),
  amount_microusd: z.string(),
  amount_usd: z.string(),
  description: z.string(),
  created_at: IsoDateTimeSchema,
});
export type BillingLedgerEntry = z.infer<typeof BillingLedgerEntrySchema>;

export const BillingPurchaseSchema = z.object({
  id: OpaqueIdSchema,
  source: z.enum(["checkout", "auto_topup", "admin_grant"]),
  status: z.enum(["pending", "paid", "failed", "canceled", "requires_action"]),
  credit_usd: z.string(),
  fee_usd: z.string(),
  total_usd: z.string(),
  created_at: IsoDateTimeSchema,
  paid_at: IsoDateTimeSchema.nullable(),
});
export type BillingPurchase = z.infer<typeof BillingPurchaseSchema>;

export const OrganizationBillingSchema = z.object({
  organization_id: OpaqueIdSchema,
  balance_microusd: z.string(),
  balance_usd: z.string(),
  can_manage: z.boolean(),
  payment_method: BillingPaymentMethodSchema.nullable(),
  auto_topup: AutoTopupPolicySchema,
  purchases: z.array(BillingPurchaseSchema),
  ledger: z.array(BillingLedgerEntrySchema),
});
export type OrganizationBilling = z.infer<typeof OrganizationBillingSchema>;

export const BillingSetupResponseSchema = z.object({
  checkout_url: z.url(),
});
export type BillingSetupResponse = z.infer<typeof BillingSetupResponseSchema>;
