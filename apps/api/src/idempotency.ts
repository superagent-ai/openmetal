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

type IdempotentWork<T> = (db: MetalDb) => Promise<{ status: number; body: T }>;

type ClaimedKey = { kind: "replay"; status: number; body: unknown } | { kind: "fresh"; id: string };

async function claimIdempotencyKey(
  tx: MetalDb,
  input: {
    principalId: string;
    operation: string;
    key: string;
    body: unknown;
  },
): Promise<ClaimedKey> {
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

  if (inserted) {
    return { kind: "fresh", id: inserted.id };
  }

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
    kind: "replay",
    status: existing.responseStatus,
    body: existing.responseBody,
  };
}

export async function executeIdempotent<T>(
  db: MetalDb,
  input: {
    principalId: string;
    operation: string;
    key: string | undefined;
    body: unknown;
  },
  work: IdempotentWork<T>,
  options: { holdTransaction?: boolean } = {},
): Promise<{ status: number; body: T; replay: boolean }> {
  const holdTransaction = options.holdTransaction ?? true;

  if (holdTransaction) {
    return withTransaction(db, async (tx) => {
      if (!input.key) {
        const result = await work(tx);
        return { ...result, replay: false };
      }
      const claimed = await claimIdempotencyKey(tx, { ...input, key: input.key });
      if (claimed.kind === "replay") {
        return { status: claimed.status, body: claimed.body as T, replay: true };
      }
      const result = await work(tx);
      await tx
        .update(idempotencyKeys)
        .set({
          responseStatus: result.status,
          responseBody: result.body,
        })
        .where(eq(idempotencyKeys.id, claimed.id));
      return { ...result, replay: false };
    });
  }

  if (!input.key) {
    const result = await work(db);
    return { ...result, replay: false };
  }

  const claimed = await withTransaction(db, (tx) =>
    claimIdempotencyKey(tx, { ...input, key: input.key! }),
  );
  if (claimed.kind === "replay") {
    return { status: claimed.status, body: claimed.body as T, replay: true };
  }

  try {
    const result = await work(db);
    await withTransaction(db, async (tx) => {
      await tx
        .update(idempotencyKeys)
        .set({
          responseStatus: result.status,
          responseBody: result.body,
        })
        .where(eq(idempotencyKeys.id, claimed.id));
    });
    return { ...result, replay: false };
  } catch (error) {
    await withTransaction(db, async (tx) => {
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claimed.id));
    });
    throw error;
  }
}
