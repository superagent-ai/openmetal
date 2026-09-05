import { eq } from "drizzle-orm";
import { autoTopupPolicies, type MetalDb } from "@openmetal/db";
import { ensureBillingAccount } from "./accounts.js";
import { postLedgerTransaction } from "./ledger.js";
import { toMicrousd } from "./money.js";

export async function prepareOrganizationBillingDeletion(
  tx: MetalDb,
  input: {
    organizationId: string;
    actorId: string;
    forfeitBalance: boolean;
  },
) {
  const account = await ensureBillingAccount(tx, input.organizationId);
  const balanceMicrousd = toMicrousd(account.balanceMicrousd);

  if (balanceMicrousd > 0n && !input.forfeitBalance) {
    return {
      prepared: false as const,
      balanceMicrousd,
    };
  }

  if (balanceMicrousd > 0n) {
    await postLedgerTransaction(tx, {
      organizationId: input.organizationId,
      kind: "adjustment",
      referenceType: "organization_deletion",
      referenceId: input.organizationId,
      description: "Credits forfeited when organization was deleted",
      actorId: input.actorId,
      lines: [
        { account: "customer_credits", amountMicrousd: -balanceMicrousd },
        { account: "platform_clearing", amountMicrousd: balanceMicrousd },
      ],
    });
  }

  await tx
    .update(autoTopupPolicies)
    .set({
      enabled: false,
      status: "disabled",
      pausedReason: "organization_deleted",
      updatedBy: input.actorId,
      updatedAt: new Date(),
    })
    .where(eq(autoTopupPolicies.organizationId, input.organizationId));

  return {
    prepared: true as const,
    forfeitedMicrousd: balanceMicrousd > 0n ? balanceMicrousd : 0n,
  };
}
