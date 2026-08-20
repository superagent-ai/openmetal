import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys, withTransaction, type MetalDb } from "@openmetal/db";
import { ApiError } from "./errors.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintBody(body: unknown): string {
  return hash(JSON.stringify(body ?? null));
}

export async function executeIdempotent<T>(
  db: MetalDb,
  input: {
    principalId: string;
    operation: string;
    key: string | undefined;
    body: unknown;
  },
  work: (tx: MetalDb) => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replay: boolean }> {
  return withTransaction(db, async (tx) => {
    if (!input.key) {
      const result = await work(tx);
      return { ...result, replay: false };
    }

    const keyHash = hash(input.key);
    const requestFingerprint = fingerprintBody(input.body);
    const [inserted] = await tx
      .insert(idempotencyKeys)
      .values({
        principalId: input.principalId,
        operation: input.operation,
        keyHash,
        requestFingerprint,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });

    if (!inserted) {
      const existing = await tx
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
      if (!existing) {
        throw new ApiError(409, "idempotency_conflict", "idempotency request conflicted");
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new ApiError(
          409,
          "idempotency_mismatch",
          "idempotency key was reused with a different request",
        );
      }
      if (existing.responseStatus == null) {
        throw new ApiError(409, "idempotency_in_progress", "idempotency request is in progress");
      }
      return {
        status: existing.responseStatus,
        body: existing.responseBody as T,
        replay: true,
      };
    }

    const result = await work(tx);
    await tx
      .update(idempotencyKeys)
      .set({
        responseStatus: result.status,
        responseBody: result.body,
      })
      .where(eq(idempotencyKeys.id, inserted.id));
    return { ...result, replay: false };
  });
}
