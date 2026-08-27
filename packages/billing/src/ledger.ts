import { eq, sql } from "drizzle-orm";
import { billingAccounts, ledgerEntries, ledgerTransactions, type MetalDb } from "@openmetal/db";
import { toMicrousd } from "./money.js";

export const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

export type LedgerLine = {
  account: "customer_credits" | "platform_clearing";
  amountMicrousd: bigint;
};

export type PostedLedgerTransaction = {
  id: string;
  organizationId: string;
  balanceMicrousd: bigint;
};

export async function postLedgerTransaction(
  tx: MetalDb,
  input: {
    organizationId: string;
    kind: "deposit" | "usage_charge" | "usage_correction" | "adjustment";
    referenceType: string;
    referenceId: string;
    description: string;
    actorId: string;
    lines: LedgerLine[];
  },
): Promise<PostedLedgerTransaction> {
  const total = input.lines.reduce((sum, line) => sum + line.amountMicrousd, 0n);
  if (total !== 0n) {
    throw new Error("ledger transaction is not balanced");
  }
  const customerDelta = input.lines
    .filter((line) => line.account === "customer_credits")
    .reduce((sum, line) => sum + line.amountMicrousd, 0n);

  const [transaction] = await tx
    .insert(ledgerTransactions)
    .values({
      organizationId: input.organizationId,
      kind: input.kind,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      actorId: input.actorId,
    })
    .returning();
  if (!transaction) {
    throw new Error("failed to persist ledger transaction");
  }
  await tx.insert(ledgerEntries).values(
    input.lines.map((line) => ({
      transactionId: transaction.id,
      organizationId: input.organizationId,
      account: line.account,
      amountMicrousd: line.amountMicrousd,
    })),
  );
  const [account] = await tx
    .update(billingAccounts)
    .set({
      balanceMicrousd: sql`${billingAccounts.balanceMicrousd} + ${customerDelta}`,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.organizationId, input.organizationId))
    .returning({
      organizationId: billingAccounts.organizationId,
      balanceMicrousd: billingAccounts.balanceMicrousd,
    });
  if (!account) {
    throw new Error("billing account not found");
  }
  return {
    id: transaction.id,
    organizationId: account.organizationId,
    balanceMicrousd: toMicrousd(account.balanceMicrousd),
  };
}
