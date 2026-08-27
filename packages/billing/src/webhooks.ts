import { withTransaction, type MetalDb } from "@openmetal/db";
import {
  fulfillCheckoutPayment,
  fulfillPaymentIntent,
  markPaymentFailed,
  persistPurchaseDocuments,
  recordStripeEvent,
  saveCustomerPaymentMethod,
} from "./purchases.js";
import { parseCheckoutSession, parsePaymentIntent, type StripeGateway } from "./stripe.js";

export async function handleStripeWebhook(
  db: MetalDb,
  stripe: StripeGateway,
  input: { payload: string | Buffer; signature: string; secret: string },
) {
  const event = stripe.constructWebhookEvent(input.payload, input.signature, input.secret);
  const result = await withTransaction(db, async (tx) => {
    const inserted = await recordStripeEvent(tx, event.id, event.type, event.data.object);
    if (!inserted) {
      return { duplicate: true, type: event.type, purchaseId: undefined as string | undefined };
    }
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = parseCheckoutSession(event.data.object);
      if (session.mode === "setup") {
        if (session.customerId && session.metadata.organization_id) {
          await saveCustomerPaymentMethod(
            tx,
            stripe,
            session.metadata.organization_id,
            session.customerId,
            session.paymentMethodId,
          );
        }
        return { duplicate: false, type: event.type, purchaseId: undefined };
      }
      const fulfilled = await fulfillCheckoutPayment(tx, stripe, session);
      return {
        duplicate: false,
        type: event.type,
        purchaseId: "purchaseId" in fulfilled ? fulfilled.purchaseId : undefined,
      };
    }
    if (event.type === "checkout.session.async_payment_failed") {
      const session = parseCheckoutSession(event.data.object);
      await markPaymentFailed(tx, {
        purchaseId: session.metadata.purchase_id,
        paymentIntentId: session.paymentIntentId ?? undefined,
      });
    } else if (event.type === "payment_intent.succeeded") {
      const fulfilled = await fulfillPaymentIntent(
        tx,
        stripe,
        parsePaymentIntent(event.data.object),
      );
      return {
        duplicate: false,
        type: event.type,
        purchaseId: "purchaseId" in fulfilled ? fulfilled.purchaseId : undefined,
      };
    } else if (
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled"
    ) {
      const intent = parsePaymentIntent(event.data.object);
      await markPaymentFailed(tx, {
        purchaseId: intent.metadata.purchase_id,
        attemptId: intent.metadata.attempt_id,
        paymentIntentId: intent.id,
        requiresAction: intent.status === "requires_action",
      });
    }
    return { duplicate: false, type: event.type, purchaseId: undefined };
  });
  if (!result.duplicate && result.purchaseId) {
    await persistPurchaseDocuments(db, stripe, result.purchaseId);
  }
  return result;
}
