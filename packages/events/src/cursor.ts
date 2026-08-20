import { Buffer } from "node:buffer";
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

export function serializeCursor(sequence: bigint | number | string): string {
  const n = typeof sequence === "bigint" ? sequence.toString() : String(sequence);
  if (!/^[0-9]+$/.test(n)) {
    throw new CursorError("cursor sequence must be a non-negative integer");
  }
  return Buffer.from(JSON.stringify({ v: 1, n }), "utf8").toString("base64url");
}

export function parseCursor(cursor: string): bigint {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = CursorPayloadSchema.parse(JSON.parse(json));
    return BigInt(parsed.n);
  } catch {
    throw new CursorError("malformed cursor");
  }
}

export function detectCursorGap(previous: bigint, incoming: bigint): boolean {
  return incoming > previous + 1n;
}
