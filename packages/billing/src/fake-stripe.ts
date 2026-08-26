import type {
  StripeCheckoutInput,
  StripeGateway,
  StripePaymentIntentInput,
  StripePaymentIntentSnapshot,
  StripePaymentMethodSnapshot,
  StripeSetupCheckoutInput,
  StripeWebhookEvent,
} from "./stripe.js";

export type FakeStripeBehavior = {
  paymentIntentStatus?: "succeeded" | "requires_action" | "payment_failed";
};

export class FakeStripeGateway implements StripeGateway {
  readonly customers = new Map<string, { id: string; organizationId: string }>();
  readonly checkoutSessions: Array<{ id: string; url: string; input: StripeCheckoutInput }> = [];
  readonly setupSessions: Array<{ id: string; url: string; input: StripeSetupCheckoutInput }> = [];
  readonly paymentIntents: StripePaymentIntentSnapshot[] = [];
  paymentMethods = new Map<string, StripePaymentMethodSnapshot>([
    ["pm_test_visa", { id: "pm_test_visa", brand: "visa", last4: "4242" }],
  ]);
  webhookEvents: StripeWebhookEvent[] = [];
  behavior: FakeStripeBehavior;

  constructor(behavior: FakeStripeBehavior = {}) {
    this.behavior = behavior;
  }

  async createCustomer(input: { organizationId: string; name: string }) {
    const id = `cus_test_${input.organizationId.replaceAll("-", "").slice(0, 14)}`;
    this.customers.set(id, { id, organizationId: input.organizationId });
    return { id };
  }

  async createCheckoutSession(input: StripeCheckoutInput) {
    const id = `cs_test_${input.purchaseId.replaceAll("-", "").slice(0, 16)}`;
    const url = `https://checkout.stripe.test/session/${id}`;
    this.checkoutSessions.push({ id, url, input });
    return { id, url };
  }

  async createSetupCheckoutSession(input: StripeSetupCheckoutInput) {
    const id = `cs_setup_${input.organizationId.replaceAll("-", "").slice(0, 16)}`;
    const url = `https://checkout.stripe.test/setup/${id}`;
    this.setupSessions.push({ id, url, input });
    return { id, url };
  }

  async createOffSessionPaymentIntent(input: StripePaymentIntentInput) {
    const status = this.behavior.paymentIntentStatus ?? "succeeded";
    const intent: StripePaymentIntentSnapshot = {
      id: `pi_test_${input.attemptId.replaceAll("-", "").slice(0, 16)}`,
      status: status === "payment_failed" ? "requires_payment_method" : status,
      customerId: input.customerId,
      paymentMethodId: input.paymentMethodId,
      amount: input.totalCents,
      currency: "usd",
      metadata: {
        organization_id: input.organizationId,
        purchase_id: input.purchaseId,
        attempt_id: input.attemptId,
        credit_microusd: input.creditMicrousd.toString(),
        fee_microusd: input.feeMicrousd.toString(),
      },
    };
    this.paymentIntents.push(intent);
    return intent;
  }

  async retrievePaymentMethod(paymentMethodId: string) {
    return (
      this.paymentMethods.get(paymentMethodId) ?? {
        id: paymentMethodId,
        brand: "visa",
        last4: "4242",
      }
    );
  }

  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    _secret: string,
  ): StripeWebhookEvent {
    if (signature !== "test_signature") {
      throw new Error("invalid stripe webhook signature");
    }
    const event = JSON.parse(
      typeof payload === "string" ? payload : payload.toString("utf8"),
    ) as StripeWebhookEvent;
    this.webhookEvents.push(event);
    return event;
  }
}
