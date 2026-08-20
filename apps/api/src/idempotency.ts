import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys, type MetalDb } from "@openmetal/db";
import { ApiError } from "./errors.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintBody(body: unknown): string {
  return hash(JSON.stringify(body ?? null));
}

export async function beginIdempotency(
  db: MetalDb,
  input: {
    principalId: string;
    operation: string;
    key: string | undefined;
    body: unknown;
  },
): Promise<{ replay?: { status: number; body: unknown } } | undefined> {
  if (!input.key) {
    return undefined;
  }
  const keyHash = hash(input.key);
  const requestFingerprint = fingerprintBody(input.body);
  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.principalId, input.principalId),
        eq(idempotencyKeys.operation, input.operation),
        eq(idempotencyKeys.keyHash, keyHash),
      ),
    )
    .then((rows) => rows[0]);

  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new ApiError(
        409,
        "idempotency_mismatch",
        "idempotency key was reused with a different request",
      );
    }
    if (existing.responseStatus != null) {
      return { replay: { status: existing.responseStatus, body: existing.responseBody } };
    }
  }

  if (!existing) {
    await db.insert(idempotencyKeys).values({
      principalId: input.principalId,
      operation: input.operation,
      keyHash,
      requestFingerprint,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }
  return {};
}

export async function completeIdempotency(
  db: MetalDb,
  input: {
    principalId: string;
    operation: string;
    key: string | undefined;
    status: number;
    body: unknown;
  },
): Promise<void> {
  if (!input.key) {
    return;
  }
  await db
    .update(idempotencyKeys)
    .set({
      responseStatus: input.status,
      responseBody: input.body,
    })
    .where(
      and(
        eq(idempotencyKeys.principalId, input.principalId),
        eq(idempotencyKeys.operation, input.operation),
        eq(idempotencyKeys.keyHash, hash(input.key)),
      ),
    );
}
