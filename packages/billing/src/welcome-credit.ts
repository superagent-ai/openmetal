import { eq } from "drizzle-orm";
import { userWelcomeCreditGrants, type MetalDb } from "@openmetal/db";
import { recordBillingEvent } from "./events.js";
import { grantCredits } from "./purchases.js";

export const WELCOME_CREDIT_MICROUSD = 500_000_000n;

export async function maybeGrantWelcomeCredit(
  tx: MetalDb,
  input: {
    userId: string;
    organizationId: string;
  },
) {
  const [claim] = await tx
    .insert(userWelcomeCreditGrants)
    .values({
      userId: input.userId,
      organizationId: input.organizationId,
      creditMicrousd: WELCOME_CREDIT_MICROUSD,
      status: "granted",
    })
    .onConflictDoNothing({ target: userWelcomeCreditGrants.userId })
    .returning({ userId: userWelcomeCreditGrants.userId });

  if (!claim) {
    return { granted: false as const };
  }

  const result = await grantCredits(tx, {
    organizationId: input.organizationId,
    creditMicrousd: WELCOME_CREDIT_MICROUSD,
    actorId: input.userId,
    source: "welcome_grant",
    description: "Welcome credit $500.00 USD",
  });

  await tx
    .update(userWelcomeCreditGrants)
    .set({ creditPurchaseId: result.purchase.id })
    .where(eq(userWelcomeCreditGrants.userId, input.userId));

  await recordBillingEvent(tx, {
    type: "billing.credits_granted",
    organizationId: input.organizationId,
    actorId: input.userId,
    data: {
      purchase_id: result.purchase.id,
      credit_microusd: WELCOME_CREDIT_MICROUSD.toString(),
      balance_microusd: result.balanceMicrousd.toString(),
      source: "welcome_grant",
    },
  });

  return {
    granted: true as const,
    purchaseId: result.purchase.id,
    balanceMicrousd: result.balanceMicrousd,
  };
}
