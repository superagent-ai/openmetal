import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  domainEvents,
  outboxJobs,
  processEvents,
  runtimeOperations,
  sandboxEndpoints,
  sandboxProcesses,
  sandboxes,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import {
  ProcessSchema,
  RuntimeOperationSchema,
  SandboxEndpointSchema,
  type CreateProcessRequest,
  type CreateSandboxEndpointRequest,
  type DeleteFileRequest,
  type ListFilesRequest,
  type ProviderRuntimeCapabilities,
  type ReadFileRequest,
  type RuntimeOperationKind,
  type WriteFileRequest,
} from "@openmetal/contracts";
import {
  projectTopic,
  publicationDedupeKey,
  serializeCursor,
  toPublicEvent,
} from "@openmetal/events";
import { ApiError } from "./errors.js";
import { getSandbox } from "./services.js";

type Scope = { organizationId: string; projectId: string; sandboxId: string };

const terminalProcessStates = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const MAX_PROCESS_EVENT_BATCH_COUNT = 100;
const MAX_PROCESS_EVENT_BATCH_BYTES = 1 * 1_024 * 1_024;

function publicProjectId(id: string): string {
  return `prj_${id.replaceAll("-", "")}`;
}

function exposedCapabilities(
  value: Record<string, unknown> | null,
): ProviderRuntimeCapabilities | undefined {
  if (!value) return undefined;
  const parsed = value as unknown as ProviderRuntimeCapabilities;
  return parsed.provider && parsed.version ? parsed : undefined;
}

function serializeProcessWithSandbox(
  row: typeof sandboxProcesses.$inferSelect,
  sandboxPublicId: string,
) {
  return ProcessSchema.parse({
    ...serializeProcessFields(row),
    sandbox_id: sandboxPublicId,
  });
}

function serializeProcessFields(row: typeof sandboxProcesses.$inferSelect) {
  return {
    id: row.publicId,
    type: "process" as const,
    project_id: publicProjectId(row.projectId),
    state: row.state,
    command: row.command,
    cwd: row.cwd,
    timeout_seconds: row.timeoutSeconds,
    max_output_bytes: row.maxOutputBytes,
    output_bytes: row.outputBytes,
    output_truncated: row.outputTruncated,
    exit_code: row.exitCode,
    termination_signal: row.terminationSignal,
    error: row.error,
    cancel_requested_at: row.cancelRequestedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    provider_capabilities: exposedCapabilities(row.providerCapabilities),
  };
}

export function serializeRuntimeOperation(
  row: typeof runtimeOperations.$inferSelect,
  sandboxPublicId: string,
) {
  return RuntimeOperationSchema.parse({
    id: row.publicId,
    type: "runtime_operation",
    project_id: publicProjectId(row.projectId),
    sandbox_id: sandboxPublicId,
    kind: row.kind,
    state: row.state,
    result: row.result,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    provider_capabilities: exposedCapabilities(row.providerCapabilities),
  });
}

export function serializeEndpoint(
  row: typeof sandboxEndpoints.$inferSelect,
  sandboxPublicId: string,
) {
  return SandboxEndpointSchema.parse({
    id: row.publicId,
    type: "sandbox_endpoint",
    project_id: publicProjectId(row.projectId),
    sandbox_id: sandboxPublicId,
    port: row.port,
    protocol: row.protocol,
    state: row.state,
    url: row.url,
    lease_expires_at: row.leaseExpiresAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    provider_capabilities: exposedCapabilities(row.providerCapabilities),
  });
}

async function requireRuntimeSandbox(db: MetalDb, scope: Scope) {
  const sandbox = await getSandbox(db, scope);
  if (sandbox.status !== "ready") {
    throw new ApiError(
      409,
      "invalid_sandbox_state",
      "sandbox must be ready for runtime operations",
    );
  }
  if (!sandbox.providerResourceId) {
    throw new ApiError(409, "invalid_sandbox_state", "sandbox has no active provider resource");
  }
  return sandbox;
}

async function appendProcessEvent(
  db: MetalDb,
  processId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  await db.execute(
    // The process row lock serializes sequence allocation across execute and cancel workers.
    // Drizzle's SQL fragment keeps this atomic without adding another schema primitive.
    sql`
      with locked as (
        select id from metal.sandbox_processes where id = ${processId} for update
      )
      insert into metal.process_events (process_id, sequence, type, data)
      select ${processId}, coalesce(max(events.sequence), 0) + 1, ${type}, ${JSON.stringify(data)}::jsonb
      from locked
      left join metal.process_events events on events.process_id = locked.id
      group by locked.id
    `,
  );
}

async function recordProcessDomainEvent(
  tx: MetalDb,
  input: {
    type: "process.queued" | "process.cancel_requested";
    organizationId: string;
    projectId: string;
    projectPublicId: string;
    actorId: string;
    processPublicId: string;
    sandboxPublicId: string;
  },
) {
  const [event] = await tx
    .insert(domainEvents)
    .values({
      type: input.type,
      organizationId: input.organizationId,
      projectId: input.projectId,
      actorId: input.actorId,
      payload: {
        process_id: input.processPublicId,
        sandbox_id: input.sandboxPublicId,
      },
    })
    .returning();
  if (!event) throw new ApiError(500, "internal_error", "failed to persist process event");
  const publicEvent = toPublicEvent({
    cursor: serializeCursor(event.cursor),
    eventId: event.eventId,
    type: event.type,
    organizationId: event.organizationId,
    projectId: input.projectPublicId,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
  await tx.insert(outboxJobs).values({
    jobType: "realtime.broadcast",
    dedupeKey: publicationDedupeKey(event.eventId),
    payload: {
      job_type: "realtime.broadcast",
      topic: projectTopic(input.projectPublicId),
      event: publicEvent,
    },
  });
}

export async function createProcess(db: MetalDb, input: Scope & { request: CreateProcessRequest }) {
  return withTransaction(db, async (tx) => {
    const sandbox = await requireRuntimeSandbox(tx, input);
    const [process] = await tx
      .insert(sandboxProcesses)
      .values({
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        sandboxId: sandbox.id,
        command: [...input.request.command],
        cwd: input.request.cwd,
        environment: input.request.environment ?? {},
        timeoutSeconds: input.request.timeout_seconds,
        maxOutputBytes: input.request.max_output_bytes,
      })
      .returning();
    if (!process) throw new ApiError(500, "internal_error", "failed to create process");
    await appendProcessEvent(tx, process.id, "queued");
    await recordProcessDomainEvent(tx, {
      type: "process.queued",
      organizationId: sandbox.organizationId,
      projectId: sandbox.projectId,
      projectPublicId: publicProjectId(sandbox.projectId),
      actorId: sandbox.createdBy,
      processPublicId: process.publicId,
      sandboxPublicId: sandbox.publicId,
    });
    await tx.insert(outboxJobs).values({
      jobType: "process.execute",
      dedupeKey: `process:execute:${process.id}`,
      payload: { job_type: "process.execute", process_id: process.id },
    });
    return serializeProcessWithSandbox(process, sandbox.publicId);
  });
}

export async function getProcess(db: MetalDb, scope: Scope & { processId: string }) {
  const scopedSandbox = await getSandbox(db, scope);
  const row = await db
    .select({ process: sandboxProcesses, sandboxPublicId: sandboxes.publicId })
    .from(sandboxProcesses)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxProcesses.sandboxId))
    .where(
      and(
        eq(sandboxProcesses.publicId, scope.processId),
        eq(sandboxProcesses.organizationId, scope.organizationId),
        eq(sandboxProcesses.projectId, scope.projectId),
        eq(sandboxProcesses.sandboxId, scopedSandbox.id),
      ),
    )
    .then((rows) => rows[0]);
  if (!row) throw new ApiError(404, "not_found", "process not found");
  return {
    row: row.process,
    serialized: serializeProcessWithSandbox(row.process, row.sandboxPublicId),
  };
}

export async function listProcessEvents(
  db: MetalDb,
  scope: Scope & { processId: string; after: number },
) {
  const process = await getProcess(db, scope);
  const events = await db
    .select()
    .from(processEvents)
    .where(
      and(eq(processEvents.processId, process.row.id), gt(processEvents.sequence, scope.after)),
    )
    .orderBy(asc(processEvents.sequence))
    .limit(MAX_PROCESS_EVENT_BATCH_COUNT);
  const bounded = [];
  let totalBytes = 0;
  for (const event of events) {
    const publicEvent = {
      sequence: event.sequence,
      process_id: process.serialized.id,
      type: event.type,
      occurred_at: event.occurredAt.toISOString(),
      data: event.data,
    };
    const eventBytes = Buffer.byteLength(
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(publicEvent)}\n\n`,
      "utf8",
    );
    if (totalBytes + eventBytes > MAX_PROCESS_EVENT_BATCH_BYTES) break;
    bounded.push(event);
    totalBytes += eventBytes;
  }
  return {
    process: process.serialized,
    events: bounded,
  };
}

export async function cancelProcess(db: MetalDb, scope: Scope & { processId: string }) {
  return withTransaction(db, async (tx) => {
    const process = await getProcess(tx, scope);
    if (
      terminalProcessStates.includes(process.row.state as (typeof terminalProcessStates)[number])
    ) {
      throw new ApiError(409, "process_terminal", "process is already terminal");
    }
    const capabilities = process.row.providerCapabilities as {
      process?: { cancel?: boolean };
    } | null;
    if (capabilities?.process?.cancel === false) {
      throw new ApiError(
        409,
        "capability_unsupported",
        "the sandbox provider does not support process cancellation",
      );
    }
    const now = new Date();
    const [updated] = await tx
      .update(sandboxProcesses)
      .set({ state: "cancelling", cancelRequestedAt: now })
      .where(
        and(
          eq(sandboxProcesses.id, process.row.id),
          inArray(sandboxProcesses.state, ["queued", "running", "cancelling"]),
        ),
      )
      .returning();
    if (!updated) throw new ApiError(409, "process_terminal", "process is already terminal");
    if (process.row.state !== "cancelling") {
      const sandbox = await getSandbox(tx, scope);
      await recordProcessDomainEvent(tx, {
        type: "process.cancel_requested",
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        projectPublicId: publicProjectId(sandbox.projectId),
        actorId: sandbox.createdBy,
        processPublicId: updated.publicId,
        sandboxPublicId: sandbox.publicId,
      });
    }
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "process.cancel",
        dedupeKey: `process:cancel:${updated.id}`,
        payload: { job_type: "process.cancel", process_id: updated.id },
      })
      .onConflictDoNothing();
    return serializeProcessWithSandbox(updated, scope.sandboxId);
  });
}

export async function createRuntimeOperation(
  db: MetalDb,
  input: Scope & {
    kind: RuntimeOperationKind;
    request: ReadFileRequest | WriteFileRequest | ListFilesRequest | DeleteFileRequest;
  },
) {
  return withTransaction(db, async (tx) => {
    const sandbox = await requireRuntimeSandbox(tx, input);
    const [operation] = await tx
      .insert(runtimeOperations)
      .values({
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        sandboxId: sandbox.id,
        kind: input.kind,
        request: input.request,
      })
      .returning();
    if (!operation) throw new ApiError(500, "internal_error", "failed to create runtime operation");
    const jobType = input.kind.replace("filesystem_", "filesystem.");
    await tx.insert(outboxJobs).values({
      jobType,
      dedupeKey: `runtime:${input.kind}:${operation.id}`,
      payload: { job_type: jobType, runtime_operation_id: operation.id },
    });
    return serializeRuntimeOperation(operation, sandbox.publicId);
  });
}

export async function getRuntimeOperation(
  db: MetalDb,
  scope: Scope & { runtimeOperationId: string },
) {
  const scopedSandbox = await getSandbox(db, scope);
  const row = await db
    .select({ operation: runtimeOperations, sandboxPublicId: sandboxes.publicId })
    .from(runtimeOperations)
    .innerJoin(sandboxes, eq(sandboxes.id, runtimeOperations.sandboxId))
    .where(
      and(
        eq(runtimeOperations.publicId, scope.runtimeOperationId),
        eq(runtimeOperations.organizationId, scope.organizationId),
        eq(runtimeOperations.projectId, scope.projectId),
        eq(runtimeOperations.sandboxId, scopedSandbox.id),
      ),
    )
    .then((rows) => rows[0]);
  if (!row) throw new ApiError(404, "not_found", "runtime operation not found");
  return serializeRuntimeOperation(row.operation, row.sandboxPublicId);
}

export async function createEndpoint(
  db: MetalDb,
  input: Scope & { request: CreateSandboxEndpointRequest },
) {
  return withTransaction(db, async (tx) => {
    const sandbox = await requireRuntimeSandbox(tx, input);
    const [endpoint] = await tx
      .insert(sandboxEndpoints)
      .values({
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        sandboxId: sandbox.id,
        port: input.request.port,
        protocol: input.request.protocol,
        leaseExpiresAt: sql`transaction_timestamp() + (${input.request.lease_seconds} * interval '1 second')`,
      })
      .returning();
    if (!endpoint) throw new ApiError(500, "internal_error", "failed to create endpoint");
    await tx.insert(outboxJobs).values({
      jobType: "endpoint.create",
      dedupeKey: `endpoint:create:${endpoint.id}`,
      payload: { job_type: "endpoint.create", endpoint_id: endpoint.id },
    });
    return serializeEndpoint(endpoint, sandbox.publicId);
  });
}

export async function listEndpoints(
  db: MetalDb,
  scope: Scope & { cursor?: string; limit: number },
) {
  const scopedSandbox = await getSandbox(db, scope);
  const rows = await db
    .select()
    .from(sandboxEndpoints)
    .where(
      and(
        eq(sandboxEndpoints.organizationId, scope.organizationId),
        eq(sandboxEndpoints.projectId, scope.projectId),
        eq(sandboxEndpoints.sandboxId, scopedSandbox.id),
      ),
    )
    .orderBy(desc(sandboxEndpoints.createdAt), desc(sandboxEndpoints.id));
  const start = scope.cursor
    ? rows.findIndex((endpoint) => endpoint.publicId === scope.cursor) + 1
    : 0;
  if (scope.cursor && start === 0) {
    throw new ApiError(422, "validation_error", "invalid endpoint cursor");
  }
  const page = rows.slice(start, start + scope.limit);
  return {
    endpoints: page.map((endpoint) => serializeEndpoint(endpoint, scope.sandboxId)),
    next_cursor: rows.length > start + scope.limit ? (page.at(-1)?.publicId ?? null) : null,
  };
}

export async function revokeEndpoint(db: MetalDb, scope: Scope & { endpointId: string }) {
  return withTransaction(db, async (tx) => {
    const scopedSandbox = await getSandbox(tx, scope);
    const endpoint = await tx
      .select()
      .from(sandboxEndpoints)
      .where(
        and(
          eq(sandboxEndpoints.publicId, scope.endpointId),
          eq(sandboxEndpoints.organizationId, scope.organizationId),
          eq(sandboxEndpoints.projectId, scope.projectId),
          eq(sandboxEndpoints.sandboxId, scopedSandbox.id),
        ),
      )
      .then((rows) => rows[0]);
    if (!endpoint) throw new ApiError(404, "not_found", "endpoint not found");
    if (endpoint.state === "revoked" || endpoint.state === "expired") {
      return serializeEndpoint(endpoint, scope.sandboxId);
    }
    const now = new Date();
    const [updated] = await tx
      .update(sandboxEndpoints)
      .set({ state: "revoking", revokedAt: now, updatedAt: now })
      .where(eq(sandboxEndpoints.id, endpoint.id))
      .returning();
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "endpoint.revoke",
        dedupeKey: `endpoint:revoke:${endpoint.id}`,
        payload: { job_type: "endpoint.revoke", endpoint_id: endpoint.id },
      })
      .onConflictDoNothing();
    return serializeEndpoint(updated ?? endpoint, scope.sandboxId);
  });
}
