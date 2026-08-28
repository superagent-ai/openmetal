import { z } from "zod";
import type {
  ProviderCancelExecInput,
  ProviderCancelExecResult,
  ProviderCreateSandboxInput,
  ProviderDeleteFileInput,
  ProviderDeleteFileResult,
  ProviderExecEvent,
  ProviderExecInput,
  ProviderExecResult,
  ProviderFileEntry,
  ProviderListFilesInput,
  ProviderListFilesResult,
  ProviderReadFileInput,
  ProviderReadFileResult,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  ProviderWriteFileInput,
  ProviderWriteFileResult,
  SandboxProvider,
} from "@openmetal/provider-core";
import { ProviderError } from "@openmetal/provider-core";

const VCPU_MICROUSD_PER_SECOND = 14;
const RAM_GIB_MICROUSD_PER_SECOND = 4.5;
const MAX_OUTPUT_BYTES = 100 * 1_024 * 1_024;
const MAX_FILE_BYTES = 10 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 10_000;
const ENVD_PORT = "49983";

const SandboxSchema = z
  .object({
    sandboxID: z.string().min(1),
    clientID: z.string().min(1),
    templateID: z.string().min(1),
    startedAt: z.string().datetime().optional(),
    cpuCount: z.number().int().positive().optional(),
    memoryMB: z.number().int().positive().optional(),
    state: z.enum(["running", "paused"]).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    envdVersion: z.string().optional(),
    envdAccessToken: z.string().nullable().optional(),
  })
  .passthrough();

const EnvdEntrySchema = z.object({
  path: z.string(),
  type: z.string(),
  size: z.union([z.number(), z.string()]).optional(),
  modifiedTime: z.string().datetime().nullable().optional(),
});

type RuntimeConnection = {
  accessToken?: string;
};

type ProcessWireEvent = {
  event?: {
    start?: { pid?: number };
    data?: { stdout?: string; stderr?: string };
    end?: { exitCode?: number; exited?: boolean; status?: string; error?: string | null };
  };
};

function operationSignal(
  callerSignal: AbortSignal | undefined,
  deadline: Date | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clearRequestTimeout: () => void; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  const requestTimer = setTimeout(
    () => controller.abort(new Error("E2B request timed out")),
    timeoutMs,
  );
  const deadlineMs = deadline ? deadline.getTime() - Date.now() : undefined;
  const deadlineTimer =
    deadlineMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new Error("E2B operation deadline exceeded")),
          Math.max(0, deadlineMs),
        );
  return {
    signal: controller.signal,
    clearRequestTimeout: () => clearTimeout(requestTimer),
    cleanup: () => {
      clearTimeout(requestTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

function encodeConnectMessage(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const framed = new Uint8Array(payload.length + 5);
  new DataView(framed.buffer).setUint32(1, payload.length);
  framed.set(payload, 5);
  return framed;
}

async function* connectMessages(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ProcessWireEvent> {
  let buffered = new Uint8Array();
  while (true) {
    const next = await reader.read();
    if (!next.done) {
      const combined = new Uint8Array(buffered.length + next.value.length);
      combined.set(buffered);
      combined.set(next.value, buffered.length);
      buffered = combined;
    }
    while (buffered.length >= 5) {
      const size = new DataView(buffered.buffer, buffered.byteOffset + 1, 4).getUint32(0);
      if (buffered.length < size + 5) break;
      const flags = buffered[0] ?? 0;
      const payload = buffered.slice(5, size + 5);
      buffered = buffered.slice(size + 5);
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as ProcessWireEvent;
      if ((flags & 0x02) !== 0) {
        const error = (parsed as { error?: { message?: string } }).error;
        if (error?.message) throw new Error(error.message);
        return;
      }
      yield parsed;
    }
    if (next.done) {
      if (buffered.length !== 0) throw new Error("E2B returned a truncated Connect stream");
      return;
    }
  }
}

function parseExitCode(
  event: NonNullable<NonNullable<ProcessWireEvent["event"]>["end"]>,
): number | null {
  if (typeof event.exitCode === "number") return event.exitCode;
  const match = /(?:exit (?:status|code) |exited with code )(-?\d+)/i.exec(event.status ?? "");
  return match ? Number(match[1]) : event.exited ? 0 : null;
}

const LifecycleEventDataSchema = z
  .object({
    execution: z
      .object({
        execution_time: z.number().nonnegative(),
        memory_mb: z.number().int().positive(),
        started_at: z.string().datetime(),
        vcpu_count: z.number().int().positive(),
      })
      .optional(),
  })
  .passthrough()
  .nullable();
const LifecycleEventArraySchema = z.array(
  z
    .object({
      id: z.string().min(1),
      type: z.string(),
      timestamp: z.string().datetime(),
      sandboxExecutionId: z.string().min(1).optional(),
      sandbox_execution_id: z.string().min(1).optional(),
      eventData: LifecycleEventDataSchema.optional(),
      event_data: LifecycleEventDataSchema.optional(),
    })
    .passthrough()
    .transform((event) => ({
      ...event,
      sandboxExecutionId: event.sandboxExecutionId ?? event.sandbox_execution_id,
      eventData: event.eventData ?? event.event_data,
    })),
);
const LifecycleEventsSchema = z
  .union([LifecycleEventArraySchema, z.object({ events: LifecycleEventArraySchema })])
  .transform((value) => (Array.isArray(value) ? value : value.events));

function parseLifecycleEvents(response: unknown): z.infer<typeof LifecycleEventArraySchema> {
  const parsed = LifecycleEventsSchema.safeParse(response);
  if (parsed.success) return parsed.data;
  const shape =
    typeof response === "object" && response !== null
      ? Object.fromEntries(
          Object.entries(response).map(([key, value]) => [
            key,
            Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
          ]),
        )
      : typeof response;
  throw new Error(
    `E2B lifecycle events response has an unsupported shape: ${JSON.stringify(shape)}`,
    {
      cause: parsed.error,
    },
  );
}

export type E2BSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  sandboxApiUrl?: string;
  templateId?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class E2BRequestError extends Error {
  constructor(readonly status: number) {
    super(`E2B request failed (${status})`);
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b" as const;
  readonly capabilities = {
    pause: true,
    resume: true,
    cost: true,
    sizing: "template",
    sources: ["environment", "provider_template"],
    runtime: {
      process: {
        exec: true,
        streams: true,
        cancel: false,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      },
      files: {
        read: true,
        write: true,
        writeModes: ["create", "overwrite"],
        createParents: true,
        list: true,
        delete: true,
        maxReadBytes: MAX_FILE_BYTES,
        maxWriteBytes: MAX_FILE_BYTES,
        maxListEntries: MAX_LIST_ENTRIES,
      },
      httpEndpoints: { expose: false, revoke: false },
    },
  } as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly sandboxApiUrl: string;
  private readonly templateId: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimeConnections = new Map<string, RuntimeConnection>();
  private readonly activeExecutions = new Set<string>();
  private readonly cancelledExecutions = new Set<string>();

  constructor(options: E2BSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://api.e2b.app").replace(/\/$/, "");
    this.sandboxApiUrl = (options.sandboxApiUrl ?? "https://sandbox.e2b.app").replace(/\/$/, "");
    this.templateId = options.templateId ?? "base";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const templateId =
      typeof input.providerOptions?.template_id === "string"
        ? input.providerOptions.template_id
        : input.source.kind === "provider_template"
          ? input.source.template
          : (input.image ?? this.templateId);
    const existing = await this.findByMetalId(input.metalSandboxId, input.signal);
    const created =
      existing ??
      SandboxSchema.parse(
        await this.request("/sandboxes", {
          method: "POST",
          body: JSON.stringify({
            templateID: templateId,
            timeout: input.ttlMinutes * 60,
            autoPause: false,
            secure: true,
            metadata: {
              "metal.sandbox_id": input.metalSandboxId,
              "metal.organization_id": input.organizationId,
              "metal.project_id": input.projectId,
            },
          }),
          signal: input.signal,
        }),
      );
    const detail = SandboxSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(created.sandboxID)}`, {
        method: "GET",
        signal: input.signal,
      }),
    );
    this.rememberRuntimeConnection(detail);
    return {
      providerResourceId: detail.sandboxID,
      providerOrganizationId: detail.clientID,
      providerMetadata: {
        startedAt: detail.startedAt,
        cpuCount: detail.cpuCount,
        memoryMB: detail.memoryMB,
        templateId: detail.templateID,
      },
      resolvedResources: {
        vcpu: detail.cpuCount ?? input.resources.vcpu,
        memoryMb: detail.memoryMB ?? input.resources.memoryMb,
        diskMb: input.resources.diskMb ?? null,
        architecture: input.resources.architecture === "arm64" ? "arm64" : "x86_64",
        providerSize: detail.templateID,
      },
    };
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}/pause`, {
      method: "POST",
      body: JSON.stringify({ memory: true }),
      signal,
    });
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    const existing = await this.findByMetalId(metalSandboxId, signal);
    if (!existing) return null;
    this.rememberRuntimeConnection(existing);
    return {
      providerResourceId: existing.sandboxID,
      providerOrganizationId: existing.clientID,
      providerMetadata: {
        startedAt: existing.startedAt,
        cpuCount: existing.cpuCount,
        memoryMB: existing.memoryMB,
        templateId: existing.templateID,
      },
      resolvedResources:
        existing.cpuCount && existing.memoryMB
          ? {
              vcpu: existing.cpuCount,
              memoryMb: existing.memoryMB,
              diskMb: null,
              architecture: "x86_64",
              providerSize: existing.templateID,
            }
          : undefined,
    };
  }

  async resume(providerResourceId: string, signal?: AbortSignal): Promise<ProviderSandbox> {
    const detail = SandboxSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}/resume`, {
        method: "POST",
        body: JSON.stringify({ timeout: 3600 }),
        signal,
      }),
    );
    this.rememberRuntimeConnection(detail);
    return {
      providerResourceId: detail.sandboxID,
      providerOrganizationId: detail.clientID,
      providerMetadata: {
        startedAt: detail.startedAt,
        cpuCount: detail.cpuCount,
        memoryMB: detail.memoryMB,
        templateId: detail.templateID,
      },
      resolvedResources:
        detail.cpuCount && detail.memoryMB
          ? {
              vcpu: detail.cpuCount,
              memoryMb: detail.memoryMB,
              diskMb: null,
              architecture: "x86_64",
              providerSize: detail.templateID,
            }
          : undefined,
    };
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
    this.runtimeConnections.delete(providerResourceId);
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    if (input.command.length === 0) {
      throw new ProviderError("E2B command must not be empty", "invalid_request", false);
    }
    const maxOutputBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new ProviderError("E2B max output limit is invalid", "invalid_request", false);
    }
    const operation = operationSignal(input.signal, input.deadline, this.requestTimeoutMs);
    try {
      const connection = await this.runtimeConnection(input.providerResourceId, operation.signal);
      const response = await this.envdFetch(
        input.providerResourceId,
        "/process.Process/Start",
        {
          method: "POST",
          headers: { "content-type": "application/connect+json" },
          body: encodeConnectMessage({
            process: {
              cmd: input.command[0],
              args: input.command.slice(1),
              envs: input.environment ?? {},
              ...(input.cwd ? { cwd: input.cwd } : {}),
            },
            stdin: input.stdin !== undefined,
          }),
          signal: operation.signal,
        },
        connection,
      );
      operation.clearRequestTimeout();
      if (!response.ok || !response.body) {
        throw new E2BRequestError(response.status);
      }
      const reader = response.body.getReader();
      const wireEvents = connectMessages(reader)[Symbol.asyncIterator]();
      let first = await wireEvents.next();
      while (!first.done && first.value.event?.start?.pid === undefined) {
        first = await wireEvents.next();
      }
      const pid = first.done ? undefined : first.value.event?.start?.pid;
      if (pid === undefined) {
        throw new Error("E2B process stream did not include a process id");
      }
      const executionId = String(pid);
      const executionKey = `${input.providerResourceId}:${executionId}`;
      this.activeExecutions.add(executionKey);
      try {
        if (input.stdin !== undefined) {
          const bytes =
            typeof input.stdin === "string" ? new TextEncoder().encode(input.stdin) : input.stdin;
          if (bytes.length > 0) {
            await this.envdUnary(
              input.providerResourceId,
              "/process.Process/SendInput",
              {
                process: { pid },
                input: { stdin: Buffer.from(bytes).toString("base64") },
              },
              operation.signal,
              connection,
            );
          }
          await this.envdUnary(
            input.providerResourceId,
            "/process.Process/CloseStdin",
            { process: { pid } },
            operation.signal,
            connection,
          );
        }
      } catch (error) {
        void this.killExecution({
          providerResourceId: input.providerResourceId,
          executionId,
        }).catch(() => undefined);
        this.activeExecutions.delete(executionKey);
        throw error;
      }

      const events = this.processEvents(
        input.providerResourceId,
        executionId,
        wireEvents,
        reader,
        maxOutputBytes,
        operation,
      );
      return { executionId, events };
    } catch (error) {
      operation.cleanup();
      throw error;
    }
  }

  private async killExecution(input: ProviderCancelExecInput): Promise<ProviderCancelExecResult> {
    const pid = Number(input.executionId);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new ProviderError("Invalid E2B execution id", "invalid_request", false);
    }
    const operation = operationSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const executionKey = `${input.providerResourceId}:${input.executionId}`;
    try {
      const connection = await this.runtimeConnection(input.providerResourceId, operation.signal);
      if (this.activeExecutions.has(executionKey)) this.cancelledExecutions.add(executionKey);
      await this.envdUnary(
        input.providerResourceId,
        "/process.Process/SendSignal",
        { process: { pid }, signal: "SIGNAL_SIGKILL" },
        operation.signal,
        connection,
      );
      return { executionId: input.executionId, cancelled: true };
    } catch (error) {
      this.cancelledExecutions.delete(executionKey);
      if (error instanceof E2BRequestError && error.status === 404) {
        return { executionId: input.executionId, cancelled: false };
      }
      throw error;
    } finally {
      operation.cleanup();
    }
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
    if (maxBytes < 1 || maxBytes > MAX_FILE_BYTES || (input.offsetBytes ?? 0) < 0) {
      throw new ProviderError("Invalid E2B file read range", "invalid_request", false);
    }
    const operation = operationSignal(input.signal, input.deadline, this.requestTimeoutMs);
    try {
      const connection = await this.runtimeConnection(input.providerResourceId, operation.signal);
      const info = await this.envdStat(
        input.providerResourceId,
        input.path,
        operation.signal,
        connection,
      );
      const response = await this.envdFetch(
        input.providerResourceId,
        `/files?path=${encodeURIComponent(input.path)}`,
        {
          method: "GET",
          headers: {
            range: `bytes=${input.offsetBytes ?? 0}-${(input.offsetBytes ?? 0) + maxBytes - 1}`,
          },
          signal: operation.signal,
        },
        connection,
      );
      if (!response.ok) throw new E2BRequestError(response.status);
      const offsetBytes = input.offsetBytes ?? 0;
      const declaredSize = Number(info?.size);
      if (
        response.status !== 206 &&
        Number.isSafeInteger(declaredSize) &&
        declaredSize > MAX_FILE_BYTES
      ) {
        await response.body?.cancel();
        throw new ProviderError(
          "E2B file transport did not honor the bounded range",
          "unsupported",
          false,
        );
      }
      const all = await readResponseBytes(
        response,
        response.status === 206 ? maxBytes : MAX_FILE_BYTES,
      );
      const data =
        response.status === 206
          ? all.slice(0, maxBytes)
          : all.slice(offsetBytes, offsetBytes + maxBytes);
      const sizeBytes = Number.isSafeInteger(declaredSize) ? declaredSize : all.length;
      const eof = offsetBytes + data.length >= sizeBytes;
      return {
        path: input.path,
        encoding: input.encoding ?? "binary",
        data: input.encoding === "utf8" ? new TextDecoder().decode(data) : data,
        offsetBytes,
        byteLength: data.length,
        sizeBytes,
        eof,
        truncated: !eof,
      };
    } finally {
      operation.cleanup();
    }
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    const bytes =
      typeof input.data === "string" ? new TextEncoder().encode(input.data) : input.data;
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ProviderError("E2B write exceeds provider limit", "invalid_request", false);
    }
    if (input.mode === "append") {
      throw new ProviderError("E2B does not natively support append writes", "unsupported", false);
    }
    const operation = operationSignal(input.signal, input.deadline, this.requestTimeoutMs);
    try {
      const connection = await this.runtimeConnection(input.providerResourceId, operation.signal);
      const existed = await this.envdExists(
        input.providerResourceId,
        input.path,
        operation.signal,
        connection,
      );
      if (input.mode === "create" && existed) {
        throw new ProviderError("E2B file already exists", "customer", false);
      }
      if (input.createParents === false) {
        const parent = input.path.slice(0, input.path.lastIndexOf("/")) || "/";
        if (
          !(await this.envdExists(input.providerResourceId, parent, operation.signal, connection))
        ) {
          throw new ProviderError("E2B parent directory does not exist", "customer", false);
        }
      }
      const response = await this.envdFetch(
        input.providerResourceId,
        `/files?path=${encodeURIComponent(input.path)}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
          signal: operation.signal,
        },
        connection,
      );
      if (!response.ok) throw new E2BRequestError(response.status);
      return { path: input.path, bytesWritten: bytes.length, created: !existed };
    } finally {
      operation.cleanup();
    }
  }

  async listFiles(input: ProviderListFilesInput): Promise<ProviderListFilesResult> {
    const maxEntries = input.maxEntries ?? MAX_LIST_ENTRIES;
    if (maxEntries < 1 || maxEntries > MAX_LIST_ENTRIES) {
      throw new ProviderError("Invalid E2B list limit", "invalid_request", false);
    }
    const operation = operationSignal(input.signal, input.deadline, this.requestTimeoutMs);
    try {
      const connection = await this.runtimeConnection(input.providerResourceId, operation.signal);
      const response = await this.envdUnary(
        input.providerResourceId,
        "/filesystem.Filesystem/ListDir",
        { path: input.path, depth: input.recursive ? 1_000 : 1 },
        operation.signal,
        connection,
      );
      const parsed = z.object({ entries: z.array(EnvdEntrySchema) }).parse(response);
      const entries = parsed.entries.slice(0, maxEntries).map((entry): ProviderFileEntry => ({
        path: entry.path,
        type:
          entry.type === "FILE_TYPE_FILE" || entry.type === "file"
            ? "file"
            : entry.type === "FILE_TYPE_DIRECTORY" ||
                entry.type === "directory" ||
                entry.type === "dir"
              ? "directory"
              : entry.type === "FILE_TYPE_SYMLINK" || entry.type === "symlink"
                ? "symlink"
                : "other",
        sizeBytes: entry.size === undefined ? null : Number(entry.size),
        modifiedAt: entry.modifiedTime ? new Date(entry.modifiedTime) : null,
      }));
      return { entries, truncated: parsed.entries.length > maxEntries };
    } finally {
      operation.cleanup();
    }
  }

  async deleteFile(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult> {
    const operation = operationSignal(input.signal, input.deadline, this.requestTimeoutMs);
    try {
      const connection = await this.runtimeConnection(input.providerResourceId, operation.signal);
      const info = await this.envdStat(
        input.providerResourceId,
        input.path,
        operation.signal,
        connection,
        true,
      );
      if (!info) return { path: input.path, deleted: false };
      if (
        !input.recursive &&
        (info.type === "FILE_TYPE_DIRECTORY" || info.type === "directory" || info.type === "dir")
      ) {
        const listed = await this.envdUnary(
          input.providerResourceId,
          "/filesystem.Filesystem/ListDir",
          { path: input.path, depth: 1 },
          operation.signal,
          connection,
        );
        if (z.object({ entries: z.array(z.unknown()) }).parse(listed).entries.length > 0) {
          throw new ProviderError("E2B directory is not empty", "customer", false);
        }
      }
      await this.envdUnary(
        input.providerResourceId,
        "/filesystem.Filesystem/Remove",
        { path: input.path },
        operation.signal,
        connection,
      );
      return { path: input.path, deleted: true };
    } finally {
      operation.cleanup();
    }
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const response = await this.request(
      `/events/sandboxes/${encodeURIComponent(input.providerResourceId)}?limit=100&orderAsc=true`,
      { method: "GET", signal: input.signal, allowNotFound: true },
    );
    if (!response) return null;
    const events = parseLifecycleEvents(response);
    const completedExecutions = new Map<
      string,
      { durationMs: number; memoryMB: number; vcpuCount: number; timestamp: Date }
    >();
    for (const event of events) {
      const execution = event.eventData?.execution;
      if (
        execution &&
        event.sandboxExecutionId &&
        (event.type === "sandbox.lifecycle.paused" || event.type === "sandbox.lifecycle.killed")
      ) {
        const previous = completedExecutions.get(event.sandboxExecutionId);
        if (!previous || execution.execution_time > previous.durationMs) {
          completedExecutions.set(event.sandboxExecutionId, {
            durationMs: execution.execution_time,
            memoryMB: execution.memory_mb,
            vcpuCount: execution.vcpu_count,
            timestamp: new Date(event.timestamp),
          });
        }
      }
    }

    let amount = 0;
    let measuredThrough = input.to;
    for (const execution of completedExecutions.values()) {
      amount += this.executionCostMicrousd(
        execution.durationMs / 1_000,
        execution.vcpuCount,
        execution.memoryMB,
      );
      if (execution.timestamp > measuredThrough) {
        measuredThrough = execution.timestamp;
      }
    }

    let detail: z.infer<typeof SandboxSchema> | undefined;
    try {
      detail = SandboxSchema.parse(
        await this.request(`/sandboxes/${encodeURIComponent(input.providerResourceId)}`, {
          method: "GET",
          signal: input.signal,
        }),
      );
    } catch (error) {
      if (!(error instanceof E2BRequestError) || error.status !== 404) {
        throw error;
      }
    }

    const usedRunningEstimate = Boolean(
      detail?.state === "running" && detail.startedAt && detail.cpuCount && detail.memoryMB,
    );
    if (usedRunningEstimate && detail?.startedAt && detail.cpuCount && detail.memoryMB) {
      const startedAt = new Date(detail.startedAt);
      const seconds = Math.max(0, (input.to.getTime() - startedAt.getTime()) / 1_000);
      amount += this.executionCostMicrousd(seconds, detail.cpuCount, detail.memoryMB);
    }
    if (amount === 0 && !detail) {
      return null;
    }

    return {
      amountMicrousd: BigInt(Math.round(amount)),
      providerOrganizationId: input.providerOrganizationId ?? "e2b",
      measuredThrough,
      provenance: usedRunningEstimate ? "estimated_rate_card" : "provider_metered",
      confidence: usedRunningEstimate ? "low" : "medium",
      source: usedRunningEstimate ? "e2b-running-sandbox-estimate" : "e2b-lifecycle-events",
      rateCardVersion: "2026-08-21",
      raw: {
        source: "e2b-lifecycle-events",
        rateCardVersion: "2026-08-21",
        vcpuMicrousdPerSecond: VCPU_MICROUSD_PER_SECOND,
        ramGibMicrousdPerSecond: RAM_GIB_MICROUSD_PER_SECOND,
        lifecycleEvents: events,
      },
    };
  }

  private async *processEvents(
    providerResourceId: string,
    executionId: string,
    wireEvents: AsyncIterator<ProcessWireEvent>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxOutputBytes: number,
    operation: ReturnType<typeof operationSignal>,
  ): AsyncGenerator<ProviderExecEvent> {
    let sequence = 0;
    let outputBytes = 0;
    let outputTruncated = false;
    const executionKey = `${providerResourceId}:${executionId}`;
    try {
      while (true) {
        const next = await wireEvents.next();
        if (next.done) {
          throw new Error("E2B process stream ended without an exit event");
        }
        const data = next.value.event?.data;
        if (data) {
          for (const [type, encoded] of [
            ["stdout", data.stdout],
            ["stderr", data.stderr],
          ] as const) {
            if (!encoded) continue;
            const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
            const remaining = Math.max(0, maxOutputBytes - outputBytes);
            const emitted = bytes.slice(0, remaining);
            outputBytes += emitted.length;
            if (emitted.length < bytes.length) outputTruncated = true;
            if (emitted.length > 0) {
              yield {
                type,
                sequence: sequence++,
                data: emitted,
                ...(emitted.length < bytes.length ? { truncated: true } : {}),
              };
            }
          }
          continue;
        }
        const end = next.value.event?.end;
        if (end) {
          const cancelled = this.cancelledExecutions.has(executionKey);
          yield {
            type: "exit",
            sequence,
            exitCode: parseExitCode(end),
            signal: cancelled ? "SIGKILL" : null,
            cancelled,
            outputTruncated,
          };
          return;
        }
      }
    } catch (error) {
      if (operation.signal.aborted) {
        void this.killExecution({ providerResourceId, executionId }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.activeExecutions.delete(executionKey);
      this.cancelledExecutions.delete(executionKey);
      operation.cleanup();
      reader.releaseLock();
    }
  }

  private rememberRuntimeConnection(sandbox: z.infer<typeof SandboxSchema>): void {
    this.runtimeConnections.set(sandbox.sandboxID, {
      ...(sandbox.envdAccessToken ? { accessToken: sandbox.envdAccessToken } : {}),
    });
  }

  private async runtimeConnection(
    providerResourceId: string,
    signal: AbortSignal,
  ): Promise<RuntimeConnection> {
    const cached = this.runtimeConnections.get(providerResourceId);
    if (cached) return cached;
    const sandbox = SandboxSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}/connect`, {
        method: "POST",
        body: JSON.stringify({ timeout: 3_600 }),
        signal,
      }),
    );
    this.rememberRuntimeConnection(sandbox);
    return this.runtimeConnections.get(providerResourceId) ?? {};
  }

  private async envdFetch(
    providerResourceId: string,
    path: string,
    init: RequestInit,
    connection: RuntimeConnection,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("E2b-Sandbox-Id", providerResourceId);
    headers.set("E2b-Sandbox-Port", ENVD_PORT);
    headers.set("Connect-Protocol-Version", "1");
    headers.set("accept", "application/json");
    if (connection.accessToken) headers.set("X-Access-Token", connection.accessToken);
    return this.fetchImpl(`${this.sandboxApiUrl}${path}`, { ...init, headers });
  }

  private async envdUnary(
    providerResourceId: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    connection: RuntimeConnection,
  ): Promise<unknown> {
    const response = await this.envdFetch(
      providerResourceId,
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
      connection,
    );
    if (!response.ok) throw new E2BRequestError(response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async envdStat(
    providerResourceId: string,
    path: string,
    signal: AbortSignal,
    connection: RuntimeConnection,
    allowNotFound = false,
  ): Promise<z.infer<typeof EnvdEntrySchema> | undefined> {
    try {
      const response = await this.envdUnary(
        providerResourceId,
        "/filesystem.Filesystem/Stat",
        { path },
        signal,
        connection,
      );
      return EnvdEntrySchema.parse(
        z.object({ entry: EnvdEntrySchema.optional() }).parse(response).entry ?? response,
      );
    } catch (error) {
      if (allowNotFound && error instanceof E2BRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private async envdExists(
    providerResourceId: string,
    path: string,
    signal: AbortSignal,
    connection: RuntimeConnection,
  ): Promise<boolean> {
    return (await this.envdStat(providerResourceId, path, signal, connection, true)) !== undefined;
  }

  private executionCostMicrousd(seconds: number, vcpuCount: number, memoryMB: number): number {
    return (
      seconds *
      (vcpuCount * VCPU_MICROUSD_PER_SECOND + (memoryMB / 1_024) * RAM_GIB_MICROUSD_PER_SECOND)
    );
  }

  private async findByMetalId(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxSchema> | undefined> {
    const response = await this.request("/sandboxes", { method: "GET", signal });
    return z
      .array(SandboxSchema)
      .parse(response)
      .find((sandbox) => sandbox.metadata?.["metal.sandbox_id"] === metalSandboxId);
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
    },
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        "x-api-key": this.apiKey,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new E2BRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderError("E2B file response exceeds the read limit", "unsupported", false);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new ProviderError(
        "E2B file response exceeded the streaming read limit",
        "unsupported",
        false,
      );
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
