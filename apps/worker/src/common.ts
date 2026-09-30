import { eq } from "drizzle-orm";
import { operationEvents, operations, withTransaction, type MetalDb } from "@openmetal/db";
import { redactString } from "@openmetal/logger";
import { ProviderError } from "@openmetal/provider-core";

export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return redactString(error.message.slice(0, 500));
  }
  return "unknown error";
}

export async function appendOperationEvent(
  db: MetalDb,
  operationId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  // Locking the operation serializes sequence allocation across the API and workers.
  await withTransaction(db, async (tx) => {
    await tx
      .select({ id: operations.id })
      .from(operations)
      .where(eq(operations.id, operationId))
      .for("update");
    const rows = await tx
      .select({ sequence: operationEvents.sequence })
      .from(operationEvents)
      .where(eq(operationEvents.operationId, operationId));
    await tx.insert(operationEvents).values({
      operationId,
      sequence: rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1,
      type,
      data,
    });
  });
}

export async function setOperationState(
  db: MetalDb,
  operationId: string | undefined,
  state: string,
  error?: Record<string, unknown> | null,
) {
  if (!operationId) return;
  const now = new Date();
  const terminal = ["succeeded", "failed", "cancelled"].includes(state);
  await db
    .update(operations)
    .set({
      state,
      error: error ?? null,
      retryable: Boolean(error?.retryable),
      updatedAt: now,
      completedAt: terminal ? now : null,
    })
    .where(eq(operations.id, operationId));
  await appendOperationEvent(db, operationId, terminal ? "completed" : "state_changed", { state });
}

export function classifyProviderFailure(error: unknown): {
  kind: string;
  retryable: boolean;
  fallbackSafe: boolean;
  unknown: boolean;
} {
  if (error instanceof ProviderError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      fallbackSafe: ["capacity", "unavailable", "timeout_absent", "unsupported"].includes(
        error.kind,
      ),
      unknown: error.kind === "unknown_outcome",
    };
  }
  const message = safeError(error).toLowerCase();
  if (/401|403|auth/.test(message)) {
    return { kind: "provider_auth_error", retryable: false, fallbackSafe: false, unknown: false };
  }
  if (/429|capacity|quota/.test(message)) {
    return {
      kind: "provider_capacity_unavailable",
      retryable: true,
      fallbackSafe: true,
      unknown: false,
    };
  }
  if (
    /timeout|abort|fetch failed|network|econn|enotfound|eai_again|socket|terminated/.test(message)
  ) {
    return {
      kind: "provider_unknown_outcome",
      retryable: true,
      fallbackSafe: false,
      unknown: true,
    };
  }
  if (/500|502|503|unavailable/.test(message)) {
    return { kind: "provider_unavailable", retryable: true, fallbackSafe: true, unknown: false };
  }
  return { kind: "provider_error", retryable: false, fallbackSafe: false, unknown: false };
}
