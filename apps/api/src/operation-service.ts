import { and, eq } from "drizzle-orm";
import { operationEvents, operations, projects, sandboxes, type MetalDb } from "@openmetal/db";
import type { OperationState, OperationType } from "@openmetal/contracts";
import { ApiError } from "./errors.js";

export async function appendOperationEvent(
  db: MetalDb,
  operationId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  const rows = await db
    .select({ sequence: operationEvents.sequence })
    .from(operationEvents)
    .where(eq(operationEvents.operationId, operationId));
  const sequence = rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
  const [event] = await db
    .insert(operationEvents)
    .values({ operationId, sequence, type, data })
    .returning();
  return event;
}

export async function createOperation(
  db: MetalDb,
  input: {
    organizationId: string;
    projectId: string;
    sandboxId: string;
    type: OperationType;
  },
) {
  const [operation] = await db
    .insert(operations)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      sandboxId: input.sandboxId,
      type: input.type,
    })
    .returning();
  if (!operation) {
    throw new ApiError(500, "internal_error", "failed to create operation");
  }
  await appendOperationEvent(db, operation.id, "queued");
  return operation;
}

export async function updateOperation(
  db: MetalDb,
  operationId: string,
  input: {
    state: OperationState;
    retryable?: boolean;
    error?: Record<string, unknown> | null;
  },
) {
  const now = new Date();
  const terminal = ["succeeded", "failed", "cancelled"].includes(input.state);
  const [operation] = await db
    .update(operations)
    .set({
      state: input.state,
      retryable: input.retryable ?? false,
      error: input.error,
      updatedAt: now,
      completedAt: terminal ? now : null,
    })
    .where(eq(operations.id, operationId))
    .returning();
  if (operation) {
    await appendOperationEvent(db, operation.id, terminal ? "completed" : "state_changed", {
      state: input.state,
    });
  }
  return operation;
}

export async function getOperationForPrincipal(
  db: MetalDb,
  userId: string,
  operationPublicId: string,
) {
  const row = await db
    .select({ operation: operations })
    .from(operations)
    .innerJoin(projects, eq(projects.id, operations.projectId))
    .innerJoin(sandboxes, eq(sandboxes.id, operations.sandboxId))
    .where(and(eq(operations.publicId, operationPublicId), eq(sandboxes.createdBy, userId)))
    .then((rows) => rows[0]);
  if (!row) {
    throw new ApiError(404, "not_found", "operation not found");
  }
  return row.operation;
}

export async function listOperationEvents(db: MetalDb, operationId: string, after = 0) {
  const rows = await db
    .select()
    .from(operationEvents)
    .where(eq(operationEvents.operationId, operationId));
  return rows.filter((event) => event.sequence > after).sort((a, b) => a.sequence - b.sequence);
}
