import { describe, expect, it } from "vitest";
import { postLedgerTransaction } from "../src/ledger.js";
import type { MetalDb } from "@openmetal/db";

describe("ledger posting", () => {
  it("rejects unbalanced lines before writing", async () => {
    await expect(
      postLedgerTransaction({} as MetalDb, {
        organizationId: "11111111-1111-4111-8111-111111111111",
        kind: "adjustment",
        referenceType: "test",
        referenceId: "11111111-1111-4111-8111-111111111111",
        description: "unbalanced",
        actorId: "11111111-1111-4111-8111-111111111111",
        lines: [{ account: "customer_credits", amountMicrousd: 1n }],
      }),
    ).rejects.toThrow(/not balanced/);
  });
});
