import Stripe from "stripe";
import { randomLetterSuffix } from "./money.js";

export type StripeCustomerInput = {
  organizationId: string;
  name: string;
};

export type StripeCheckoutInput = {
  customerId: string;
  organizationId: string;
  organizationSlug: string;
  purchaseId: string;
  creditMicrousd: bigint;
  feeMicrousd: bigint;
  totalMicrousd: bigint;
  successUrl: string;
  cancelUrl: string;
};

export type StripeSetupCheckoutInput = {
  customerId: string;
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
};

export type StripePaymentIntentInput = {
  customerId: string;
  paymentMethodId: string;
  organizationId: string;
  purchaseId: string;
  attemptId: string;
  creditMicrousd: bigint;
  feeMicrousd: bigint;
  totalCents: number;
};

export type StripePaymentMethodSnapshot = {
  id: string;
  brand: string | null;
  last4: string | null;
};

export type StripeCheckoutSessionSnapshot = {
  id: string;
  url: string | null;
  customerId: string | null;
  paymentIntentId: string | null;
  paymentStatus: string | null;
  mode: string;
  amountTotal: number | null;
  currency: string | null;
  metadata: Record<string, string>;
  paymentMethodId: string | null;
};

export type StripePaymentIntentSnapshot = {
  id: string;
  status: string;
  customerId: string | null;
  paymentMethodId: string | null;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
};

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

export type StripeGateway = {
  createCustomer(input: StripeCustomerInput): Promise<{ id: string }>;
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ id: string; url: string }>;
  createSetupCheckoutSession(input: StripeSetupCheckoutInput): Promise<{ id: string; url: string }>;
  createOffSessionPaymentIntent(
    input: StripePaymentIntentInput,
  ): Promise<StripePaymentIntentSnapshot>;
  retrievePaymentMethod(paymentMethodId: string): Promise<StripePaymentMethodSnapshot>;
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): StripeWebhookEvent;
};

function metadataFrom(record: unknown): Record<string, string> {
  if (!record || typeof record !== "object") return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

export function createStripeGateway(secretKey: string): StripeGateway {
  const stripe = new Stripe(secretKey);

  return {
    async createCustomer(input) {
      const customer = await stripe.customers.create(
        {
          name: input.name,
          metadata: { organization_id: input.organizationId },
        },
        { idempotencyKey: `metal_customer:${input.organizationId}` },
      );
      return { id: customer.id };
    },
    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer: input.customerId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.purchaseId,
          metadata: {
            organization_id: input.organizationId,
            purchase_id: input.purchaseId,
            credit_microusd: input.creditMicrousd.toString(),
            fee_microusd: input.feeMicrousd.toString(),
            total_microusd: input.totalMicrousd.toString(),
          },
          payment_intent_data: {
            setup_future_usage: "off_session",
            metadata: {
              organization_id: input.organizationId,
              purchase_id: input.purchaseId,
            },
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: Number(input.creditMicrousd / 10_000n),
                product_data: { name: "Metal credits" },
              },
            },
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: Number(input.feeMicrousd / 10_000n),
                product_data: { name: "Platform fee" },
              },
            },
          ],
          integration_identifier: `metal_credits_${randomLetterSuffix(8)}`,
        } as Parameters<Stripe["checkout"]["sessions"]["create"]>[0],
        { idempotencyKey: `metal_checkout:${input.purchaseId}` },
      );
      if (!session.url) {
        throw new Error("stripe checkout session is missing a url");
      }
      return { id: session.id, url: session.url };
    },
    async createSetupCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer: input.customerId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: { organization_id: input.organizationId, purpose: "save_payment_method" },
        integration_identifier: `metal_setup_${randomLetterSuffix(8)}`,
      } as Parameters<Stripe["checkout"]["sessions"]["create"]>[0]);
      if (!session.url) {
        throw new Error("stripe checkout session is missing a url");
      }
      return { id: session.id, url: session.url };
    },
    async createOffSessionPaymentIntent(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.totalCents,
          currency: "usd",
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          confirm: true,
          off_session: true,
          metadata: {
            organization_id: input.organizationId,
            purchase_id: input.purchaseId,
            attempt_id: input.attemptId,
            credit_microusd: input.creditMicrousd.toString(),
            fee_microusd: input.feeMicrousd.toString(),
          },
        },
        { idempotencyKey: `auto_topup:${input.attemptId}` },
      );
      return {
        id: intent.id,
        status: intent.status,
        customerId:
          typeof intent.customer === "string" ? intent.customer : (intent.customer?.id ?? null),
        paymentMethodId:
          typeof intent.payment_method === "string"
            ? intent.payment_method
            : (intent.payment_method?.id ?? null),
        amount: intent.amount,
        currency: intent.currency,
        metadata: metadataFrom(intent.metadata),
      };
    },
    async retrievePaymentMethod(paymentMethodId) {
      const method = await stripe.paymentMethods.retrieve(paymentMethodId);
      return {
        id: method.id,
        brand: method.card?.brand ?? method.type ?? null,
        last4: method.card?.last4 ?? null,
      };
    },
    constructWebhookEvent(payload, signature, secret) {
      const event = stripe.webhooks.constructEvent(payload, signature, secret);
      return {
        id: event.id,
        type: event.type,
        data: { object: event.data.object as unknown as Record<string, unknown> },
      };
    },
  };
}

export function parseCheckoutSession(
  object: Record<string, unknown>,
): StripeCheckoutSessionSnapshot {
  const paymentIntent = object.payment_intent;
  const setupIntent = object.setup_intent;
  const customer = object.customer;
  const nestedPaymentMethod =
    paymentIntent &&
    typeof paymentIntent === "object" &&
    "payment_method" in paymentIntent &&
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : setupIntent &&
          typeof setupIntent === "object" &&
          "payment_method" in setupIntent &&
          typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : null;
  return {
    id: String(object.id ?? ""),
    url: typeof object.url === "string" ? object.url : null,
    customerId: typeof customer === "string" ? customer : null,
    paymentIntentId: typeof paymentIntent === "string" ? paymentIntent : null,
    paymentStatus: typeof object.payment_status === "string" ? object.payment_status : null,
    mode: typeof object.mode === "string" ? object.mode : "payment",
    amountTotal: typeof object.amount_total === "number" ? object.amount_total : null,
    currency: typeof object.currency === "string" ? object.currency : null,
    metadata: metadataFrom(object.metadata),
    paymentMethodId:
      typeof object.payment_method === "string" ? object.payment_method : nestedPaymentMethod,
  };
}

export function parsePaymentIntent(object: Record<string, unknown>): StripePaymentIntentSnapshot {
  const customer = object.customer;
  const paymentMethod = object.payment_method;
  return {
    id: String(object.id ?? ""),
    status: String(object.status ?? ""),
    customerId: typeof customer === "string" ? customer : null,
    paymentMethodId: typeof paymentMethod === "string" ? paymentMethod : null,
    amount: typeof object.amount === "number" ? object.amount : 0,
    currency: typeof object.currency === "string" ? object.currency : "usd",
    metadata: metadataFrom(object.metadata),
  };
}
