import { describe, expect, it } from "vitest";
import {
  formatMicrousdUsd,
  parseUsdToMicrousd,
  purchaseFeeMicrousd,
  quoteCreditPurchase,
} from "../src/money.js";

describe("credit purchase fees", () => {
  it("applies the $0.80 minimum below the 5.5% threshold", () => {
    expect(purchaseFeeMicrousd(parseUsdToMicrousd("5.00"))).toBe(800_000n);
    expect(quoteCreditPurchase(parseUsdToMicrousd("5.00"))).toEqual({
      credit_microusd: 5_000_000n,
      fee_microusd: 800_000n,
      total_microusd: 5_800_000n,
    });
  });

  it("charges 5.5% on a $100 purchase", () => {
    expect(quoteCreditPurchase(parseUsdToMicrousd("100"))).toEqual({
      credit_microusd: 100_000_000n,
      fee_microusd: 5_500_000n,
      total_microusd: 105_500_000n,
    });
  });

  it("formats and parses USD without floating point", () => {
    expect(formatMicrousdUsd(5_500_000n)).toBe("5.50");
    expect(parseUsdToMicrousd("14.55")).toBe(14_550_000n);
  });

  it("rejects amounts outside the purchase bounds", () => {
    expect(() => quoteCreditPurchase(parseUsdToMicrousd("4.99"))).toThrow(/between/);
    expect(() => quoteCreditPurchase(parseUsdToMicrousd("10000.01"))).toThrow(/between/);
  });

  it("rounds the percentage fee to whole cents", () => {
    const quote = quoteCreditPurchase(parseUsdToMicrousd("14.55"));
    expect(quote.fee_microusd % 10_000n).toBe(0n);
    expect(quote.fee_microusd).toBe(800_000n);
  });
});
