export const MICROUSD_PER_USD = 1_000_000n;
export const MICROUSD_PER_CENT = 10_000n;
export const PURCHASE_FEE_PER_MILLE = 55n;
export const PURCHASE_MIN_FEE_MICROUSD = 800_000n;
export const MIN_CREDIT_MICROUSD = 5_000_000n;
export const MAX_CREDIT_MICROUSD = 10_000_000_000n;
export const PURCHASE_FEE_CODE = "purchase_fee.v1";
export const USAGE_PRICING_CODE = "usage_passthrough.v1";

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function parseUsdToMicrousd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyError("amount must be a USD value with up to two decimal places");
  }
  const dollars = BigInt(match[1] ?? "0");
  const cents = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return dollars * MICROUSD_PER_USD + cents * MICROUSD_PER_CENT;
}

export function toMicrousd(value: bigint | number | string | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return 0n;
  return BigInt(value);
}

export function formatMicrousdUsd(amount: bigint | number | string): string {
  const value = toMicrousd(amount);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const dollars = abs / MICROUSD_PER_USD;
  const cents = (abs % MICROUSD_PER_USD) / MICROUSD_PER_CENT;
  return `${negative ? "-" : ""}${dollars}.${cents.toString().padStart(2, "0")}`;
}

export function microusdToCents(amount: bigint): number {
  if (amount % MICROUSD_PER_CENT !== 0n) {
    throw new MoneyError("amount must be a whole cent");
  }
  const cents = amount / MICROUSD_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError("amount exceeds safe integer cents");
  }
  return Number(cents);
}

export function purchaseFeeMicrousd(creditMicrousd: bigint): bigint {
  if (creditMicrousd < 0n) {
    throw new MoneyError("credit amount must be non-negative");
  }
  const percentFeeCents = (creditMicrousd * PURCHASE_FEE_PER_MILLE + 5_000_000n) / 10_000_000n;
  const percentFee = percentFeeCents * MICROUSD_PER_CENT;
  return percentFee > PURCHASE_MIN_FEE_MICROUSD ? percentFee : PURCHASE_MIN_FEE_MICROUSD;
}

export function quoteCreditPurchase(creditMicrousd: bigint): {
  credit_microusd: bigint;
  fee_microusd: bigint;
  total_microusd: bigint;
} {
  if (creditMicrousd < MIN_CREDIT_MICROUSD || creditMicrousd > MAX_CREDIT_MICROUSD) {
    throw new MoneyError(
      `credit amount must be between ${formatMicrousdUsd(MIN_CREDIT_MICROUSD)} and ${formatMicrousdUsd(MAX_CREDIT_MICROUSD)} USD`,
    );
  }
  if (creditMicrousd % MICROUSD_PER_CENT !== 0n) {
    throw new MoneyError("credit amount must be a whole cent");
  }
  const feeMicrousd = purchaseFeeMicrousd(creditMicrousd);
  return {
    credit_microusd: creditMicrousd,
    fee_microusd: feeMicrousd,
    total_microusd: creditMicrousd + feeMicrousd,
  };
}

export function utcMonthStart(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function randomLetterSuffix(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}
