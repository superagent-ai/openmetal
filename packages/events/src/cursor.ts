import { z } from "zod";

const CursorPayloadSchema = z.object({
  v: z.literal(1),
  n: z.string().regex(/^[0-9]+$/),
});

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

function encodeBase64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

export function serializeCursor(sequence: bigint | number | string): string {
  const n = typeof sequence === "bigint" ? sequence.toString() : String(sequence);
  if (!/^[0-9]+$/.test(n)) {
    throw new CursorError("cursor sequence must be a non-negative integer");
  }
  return encodeBase64Url(JSON.stringify({ v: 1, n }));
}

export function parseCursor(cursor: string): bigint {
  try {
    const json = decodeBase64Url(cursor);
    const parsed = CursorPayloadSchema.parse(JSON.parse(json));
    return BigInt(parsed.n);
  } catch {
    throw new CursorError("malformed cursor");
  }
}

export function detectCursorGap(previous: bigint, incoming: bigint): boolean {
  return incoming > previous + 1n;
}
