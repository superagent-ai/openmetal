import { z } from "zod";
import { gzipSync } from "node:zlib";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderDestroyResult,
  ProviderExecEvent,
  ProviderExecInput,
  ProviderExecResult,
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

const ACTIVE_CPU_USD_PER_HOUR = 0.128;
const MEMORY_GIB_USD_PER_HOUR = 0.0212;
const CREATION_USD = 0.0000006;
const EGRESS_USD_PER_GB = 0.15;
const MAX_RUNTIME_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const MAX_RUNTIME_FILE_BYTES = 10 * 1_024 * 1_024;

const SessionSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    vcpus: z.number().positive(),
    memory: z.number().positive(),
    duration: z.number().nonnegative().optional(),
    startedAt: z.number().optional(),
    stoppedAt: z.number().optional(),
    activeCpuDurationMs: z.number().nonnegative().optional(),
    networkTransfer: z
      .object({
        ingress: z.number().nonnegative(),
        egress: z.number().nonnegative(),
      })
      .optional(),
  })
  .passthrough();

const NamedSandboxSchema = z
  .object({
    name: z.string().min(1),
    currentSessionId: z.string().min(1).optional(),
    status: z.enum(["running", "stopped", "stopping"]),
    persistent: z.boolean(),
    vcpus: z.number().positive().optional(),
    memory: z.number().positive().optional(),
    totalActiveCpuDurationMs: z.number().nonnegative().optional(),
    totalDurationMs: z.number().nonnegative().optional(),
    totalEgressBytes: z.number().nonnegative().optional(),
    totalIngressBytes: z.number().nonnegative().optional(),
  })
  .passthrough();

const SandboxResponseSchema = z
  .object({
    sandbox: NamedSandboxSchema,
    session: SessionSchema.optional(),
  })
  .passthrough();

const StopResponseSchema = z
  .object({
    sandbox: NamedSandboxSchema.optional(),
    session: SessionSchema,
  })
  .passthrough();

const CommandSchema = z
  .object({
    id: z.string().min(1),
    exitCode: z.number().int().nullable(),
  })
  .passthrough();

const CommandResponseSchema = z.object({ command: CommandSchema }).passthrough();

const CommandLogSchema = z.object({
  stream: z.enum(["stdout", "stderr", "error"]),
  data: z.unknown(),
});

export type VercelSandboxProviderOptions = {
  token: string;
  projectId: string;
  teamId?: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class VercelRequestError extends Error {
  constructor(readonly status: number) {
    super(`Vercel request failed (${status})`);
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel" as const;
  readonly capabilities = {
    pause: false,
    cost: true,
    sizing: "fixed",
    sources: ["environment", "oci_image"],
    runtime: {
      process: {
        exec: true,
        streams: true,
        cancel: false,
        maxOutputBytes: MAX_RUNTIME_OUTPUT_BYTES,
      },
      files: {
        read: true,
        write: true,
        writeModes: ["create", "overwrite"],
        createParents: true,
        list: false,
        delete: false,
        maxReadBytes: MAX_RUNTIME_FILE_BYTES,
        maxWriteBytes: MAX_RUNTIME_FILE_BYTES,
        maxListEntries: 0,
      },
    },
  } as const;
  private readonly token: string;
  private readonly projectId: string;
  private readonly teamId?: string;
  private readonly apiUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly executions = new Map<
    string,
    { providerResourceId: string; cancelRequested: boolean }
  >();

  constructor(options: VercelSandboxProviderOptions) {
    this.token = options.token;
    this.projectId = options.projectId;
    this.teamId = options.teamId;
    this.apiUrl = (options.apiUrl ?? "https://api.vercel.com").replace(/\/$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("vercel", input.resources, input.providerOptions);
    const name = `metal-${input.metalSandboxId}`;
    const existing = await this.getNamedSandbox(name, input.signal);
    const response =
      existing ??
      SandboxResponseSchema.parse(
        await this.request(`/v4/sandboxes${this.query()}`, {
          method: "POST",
          body: JSON.stringify({
            name,
            projectId: this.projectId,
            persistent: false,
            timeout: input.ttlMinutes * 60_000,
            ...(input.image ? { image: input.image } : {}),
            tags: {
              "metal.sandbox_id": input.metalSandboxId,
              "metal.organization_id": input.organizationId,
              "metal.project_id": input.projectId,
            },
          }),
          signal: input.signal,
        }),
      );
    const session = response.session;
    return {
      providerResourceId: response.sandbox.name,
      providerOrganizationId: this.teamId ?? this.projectId,
      providerMetadata: {
        vercel: {
          sandbox: response.sandbox,
          ...(session ? { session } : {}),
        },
      },
      resolvedResources: resolved,
    };
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    if (input.command.length === 0) {
      throw new ProviderError("command must not be empty", "invalid_request", false);
    }
    if (input.stdin !== undefined) {
      throw new ProviderError(
        "Vercel Sandbox REST execution does not accept stdin",
        "unsupported",
        false,
      );
    }
    const maxOutputBytes = boundedInteger(
      input.maxOutputBytes ?? MAX_RUNTIME_OUTPUT_BYTES,
      0,
      MAX_RUNTIME_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    const signal = runtimeSignal(input);
    const sessionId = await this.currentSessionId(input.providerResourceId, signal);
    const timeout = input.deadline ? Math.max(1, input.deadline.getTime() - Date.now()) : undefined;
    const response = CommandResponseSchema.parse(
      await this.request(
        `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd${this.query()}`,
        {
          method: "POST",
          body: JSON.stringify({
            command: input.command[0],
            args: input.command.slice(1),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.environment ? { env: input.environment } : {}),
            ...(timeout ? { timeout: Math.min(timeout, 18_000_000) } : {}),
          }),
          signal,
        },
      ),
    );
    this.executions.set(response.command.id, {
      providerResourceId: input.providerResourceId,
      cancelRequested: false,
    });
    return {
      executionId: response.command.id,
      events: this.commandEvents(sessionId, response.command.id, maxOutputBytes, signal),
    };
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    const offsetBytes = boundedInteger(
      input.offsetBytes ?? 0,
      0,
      Number.MAX_SAFE_INTEGER,
      "offsetBytes",
    );
    const maxBytes = boundedInteger(
      input.maxBytes ?? MAX_RUNTIME_FILE_BYTES,
      0,
      MAX_RUNTIME_FILE_BYTES,
      "maxBytes",
    );
    const sessionId = await this.currentSessionId(input.providerResourceId, runtimeSignal(input));
    const response = await this.requestRaw(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/fs/read${this.query()}`,
      {
        method: "POST",
        body: JSON.stringify({ path: input.path }),
        signal: runtimeSignal(input),
        contentType: "application/json",
      },
    );
    const { bytes, sizeBytes } = await readBoundedResponse(response, offsetBytes, maxBytes);
    const encoding = input.encoding ?? "binary";
    const eof = offsetBytes + bytes.byteLength >= sizeBytes;
    return {
      path: input.path,
      encoding,
      data: encoding === "utf8" ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes,
      offsetBytes,
      byteLength: bytes.byteLength,
      sizeBytes,
      eof,
      truncated: !eof,
    };
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    const bytes =
      typeof input.data === "string" ? new TextEncoder().encode(input.data) : input.data.slice();
    if (bytes.byteLength > MAX_RUNTIME_FILE_BYTES) {
      throw new ProviderError("file exceeds Vercel write limit", "invalid_request", false);
    }
    if (input.mode === "append") {
      throw new ProviderError(
        "Vercel Sandbox REST file uploads do not provide atomic append",
        "unsupported",
        false,
      );
    }
    const signal = runtimeSignal(input);
    const sessionId = await this.currentSessionId(input.providerResourceId, signal);
    const existed = await this.vercelFileExists(sessionId, input.path, signal);
    if (input.mode === "create" && existed) {
      throw new ProviderError("file already exists", "invalid_request", false);
    }
    const archive = gzipSync(createTarEntry(input.path, bytes));
    await this.request(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/fs/write${this.query()}`,
      {
        method: "POST",
        body: archive,
        signal,
        contentType: "application/gzip",
        headers: { "x-cwd": "/" },
      },
    );
    return { path: input.path, bytesWritten: bytes.byteLength, created: !existed };
  }

  async pause(): Promise<void> {
    throw new Error("Vercel sandboxes do not support pause");
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<ProviderDestroyResult> {
    const existing = await this.getNamedSandbox(providerResourceId, signal);
    if (!existing) {
      return {};
    }
    let stopped: {
      sandbox: z.infer<typeof NamedSandboxSchema>;
      session?: z.infer<typeof SessionSchema>;
    } = existing;
    if (existing.sandbox.currentSessionId && existing.sandbox.status !== "stopped") {
      const stopResponse = StopResponseSchema.parse(
        await this.request(
          `/v2/sandboxes/sessions/${encodeURIComponent(
            existing.sandbox.currentSessionId,
          )}/stop${this.query()}`,
          { method: "POST", body: JSON.stringify({}), signal },
        ),
      );
      stopped = {
        sandbox: stopResponse.sandbox ?? existing.sandbox,
        session: stopResponse.session,
      };
    }
    await this.request(
      `/v2/sandboxes/${encodeURIComponent(providerResourceId)}${this.query({
        projectId: this.projectId,
      })}`,
      { method: "DELETE", signal, allowNotFound: true },
    );
    return {
      providerMetadata: {
        vercel: {
          sandbox: stopped.sandbox,
          ...(stopped.session ? { session: stopped.session } : {}),
        },
      },
    };
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const evidence = z
      .object({
        vercel: z.object({
          sandbox: NamedSandboxSchema,
          session: SessionSchema.optional(),
        }),
      })
      .safeParse(input.providerMetadata);
    const session = evidence.success ? evidence.data.vercel.session : undefined;
    const sandbox = evidence.success ? evidence.data.vercel.sandbox : undefined;
    if (session?.activeCpuDurationMs === undefined || session.duration === undefined) {
      return null;
    }
    const activeCpuCost = (session.activeCpuDurationMs / 3_600_000) * ACTIVE_CPU_USD_PER_HOUR;
    const memoryDurationMs = Math.max(session.duration, 60_000);
    const memoryCost =
      (memoryDurationMs / 3_600_000) * (session.memory / 1_024) * MEMORY_GIB_USD_PER_HOUR;
    const egressBytes = session.networkTransfer?.egress ?? sandbox?.totalEgressBytes ?? 0;
    const egressCost = (egressBytes / 1_000_000_000) * EGRESS_USD_PER_GB;
    const amountMicrousd = BigInt(
      Math.round((activeCpuCost + memoryCost + CREATION_USD + egressCost) * 1_000_000),
    );
    return {
      amountMicrousd,
      providerOrganizationId: this.teamId ?? this.projectId,
      measuredThrough: session.stoppedAt ? new Date(session.stoppedAt) : input.to,
      provenance: "estimated_rate_card",
      confidence: "medium",
      source: "vercel-session-usage",
      rateCardVersion: "2026-08-04",
      raw: {
        source: "vercel-session-usage",
        rateCardVersion: "2026-08-04",
        activeCpuUsdPerHour: ACTIVE_CPU_USD_PER_HOUR,
        memoryGibUsdPerHour: MEMORY_GIB_USD_PER_HOUR,
        creationUsd: CREATION_USD,
        egressUsdPerGb: EGRESS_USD_PER_GB,
        session,
      },
    };
  }

  private async getNamedSandbox(
    name: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxResponseSchema> | undefined> {
    try {
      return SandboxResponseSchema.parse(
        await this.request(
          `/v2/sandboxes/${encodeURIComponent(name)}${this.query({
            projectId: this.projectId,
            resume: "false",
          })}`,
          { method: "GET", signal },
        ),
      );
    } catch (error) {
      if (error instanceof VercelRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private async currentSessionId(name: string, signal?: AbortSignal): Promise<string> {
    const sandbox = await this.getNamedSandbox(name, signal);
    const sessionId = sandbox?.sandbox.currentSessionId ?? sandbox?.session?.id;
    if (!sessionId || sandbox?.sandbox.status !== "running") {
      throw new ProviderError("Vercel sandbox has no running session", "invalid_request", false);
    }
    return sessionId;
  }

  private async *commandEvents(
    sessionId: string,
    commandId: string,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderExecEvent> {
    let sequence = 0;
    let emittedBytes = 0;
    let outputTruncated = false;
    try {
      const response = await this.requestRaw(
        `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd/${encodeURIComponent(
          commandId,
        )}/logs${this.query()}`,
        { method: "GET", signal, accept: "application/x-ndjson" },
      );
      for await (const value of ndjsonStream(response)) {
        const event = CommandLogSchema.parse(value);
        if (event.stream === "error") {
          throw new ProviderError("Vercel command log stream failed", "unavailable", true);
        }
        if (typeof event.data !== "string") continue;
        const bytes = new TextEncoder().encode(event.data);
        const available = Math.max(0, maxOutputBytes - emittedBytes);
        const data = bytes.slice(0, available);
        const truncated = data.byteLength < bytes.byteLength;
        outputTruncated ||= truncated;
        emittedBytes += data.byteLength;
        if (data.byteLength > 0) {
          yield {
            type: event.stream,
            sequence: sequence++,
            data,
            ...(truncated ? { truncated } : {}),
          };
        }
      }
      const completed = CommandResponseSchema.parse(
        await this.request(
          `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd/${encodeURIComponent(
            commandId,
          )}${this.query({ wait: "true" })}`,
          { method: "GET", signal },
        ),
      );
      yield {
        type: "exit",
        sequence,
        exitCode: completed.command.exitCode,
        signal: null,
        cancelled: this.executions.get(commandId)?.cancelRequested ?? false,
        outputTruncated,
      };
    } catch (error) {
      if (signal?.aborted) {
        const recoverySignal = AbortSignal.timeout(this.requestTimeoutMs);
        await this.sendKillCommand(sessionId, commandId, recoverySignal).catch(() => undefined);
        const tracked = this.executions.get(commandId);
        if (tracked) tracked.cancelRequested = true;
      }
      throw error;
    } finally {
      this.executions.delete(commandId);
    }
  }

  private async sendKillCommand(
    sessionId: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd/${encodeURIComponent(
        commandId,
      )}/kill${this.query()}`,
      {
        method: "POST",
        body: JSON.stringify({ signal: 9 }),
        signal,
      },
    );
  }

  private async vercelFileExists(
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.requestRaw(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/fs/read${this.query()}`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
        signal,
        contentType: "application/json",
        allowNotFound: true,
      },
    );
    if (response.status === 404) return false;
    await response.body?.cancel();
    return true;
  }

  private query(extra: Record<string, string> = {}): string {
    const query = new URLSearchParams(extra);
    if (this.teamId) {
      query.set("teamId", this.teamId);
    }
    const value = query.toString();
    return value ? `?${value}` : "";
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "PATCH" | "POST";
      body?: string | Uint8Array;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      accept?: string;
      contentType?: string;
      headers?: Record<string, string>;
    },
  ): Promise<unknown> {
    const response = await this.requestRaw(path, options);
    if (options.allowNotFound && response.status === 404) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async requestRaw(
    path: string,
    options: {
      method: "DELETE" | "GET" | "PATCH" | "POST";
      body?: string | Uint8Array;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      accept?: string;
      contentType?: string;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: options.accept ?? "application/json",
        ...(options.contentType
          ? { "content-type": options.contentType }
          : typeof options.body === "string"
            ? { "content-type": "application/json" }
            : {}),
        ...options.headers,
      },
      body: options.body,
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return response;
    }
    if (!response.ok) {
      throw new VercelRequestError(response.status);
    }
    return response;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProviderError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
      "invalid_request",
      false,
    );
  }
  return value;
}

function runtimeSignal(operation: {
  deadline?: Date;
  signal?: AbortSignal;
}): AbortSignal | undefined {
  operation.signal?.throwIfAborted();
  if (!operation.deadline) return operation.signal;
  const remaining = operation.deadline.getTime() - Date.now();
  if (remaining <= 0) {
    throw new ProviderError("runtime operation deadline exceeded", "timeout_absent", false);
  }
  const deadlineSignal = AbortSignal.timeout(remaining);
  return operation.signal ? AbortSignal.any([operation.signal, deadlineSignal]) : deadlineSignal;
}

async function readBoundedResponse(
  response: Response,
  offsetBytes: number,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; sizeBytes: number }> {
  const declaredLength = response.headers.get("content-length");
  const contentLength =
    declaredLength !== null && /^\d+$/.test(declaredLength) ? Number(declaredLength) : undefined;
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), sizeBytes: contentLength ?? 0 };
  const end = offsetBytes + maxBytes;
  const selected: number[] = [];
  let position = 0;
  let reachedEof = false;
  while (position <= end) {
    const chunk = await reader.read();
    if (chunk.done) {
      reachedEof = true;
      break;
    }
    for (const byte of chunk.value) {
      if (position >= offsetBytes && position < end) selected.push(byte);
      position += 1;
      if (position > end) break;
    }
  }
  if (!reachedEof) await reader.cancel();
  if (contentLength === undefined && !reachedEof) {
    throw new ProviderError(
      "provider omitted Content-Length for a truncated file response",
      "unsupported",
      false,
    );
  }
  return { bytes: Uint8Array.from(selected), sizeBytes: contentLength ?? position };
}

async function* ndjsonStream(response: Response): AsyncIterable<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await reader.read();
    buffer += decoder.decode(result.value, { stream: !result.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
    if (result.done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

function createTarEntry(path: string, bytes: Uint8Array): Uint8Array {
  if (!path.startsWith("/") || path === "/" || path.includes("\0")) {
    throw new ProviderError(
      "Vercel file path must identify an absolute file",
      "invalid_request",
      false,
    );
  }
  const archivePath = path.slice(1);
  const encoder = new TextEncoder();
  let name = archivePath;
  let prefix = "";
  if (encoder.encode(name).byteLength > 100) {
    const segments = archivePath.split("/");
    while (segments.length > 1 && encoder.encode(segments.join("/")).byteLength > 100) {
      prefix = prefix ? `${prefix}/${segments.shift()}` : (segments.shift() ?? "");
    }
    name = segments.join("/");
  }
  const nameBytes = encoder.encode(name);
  const prefixBytes = encoder.encode(prefix);
  if (nameBytes.byteLength > 100 || prefixBytes.byteLength > 155) {
    throw new ProviderError("Vercel REST tar path exceeds the USTAR limit", "unsupported", false);
  }
  const header = new Uint8Array(512);
  header.set(nameBytes, 0);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.byteLength);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1_000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  header.set(prefixBytes, 345);
  writeTarOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  const paddedLength = Math.ceil(bytes.byteLength / 512) * 512;
  const tar = new Uint8Array(512 + paddedLength + 1_024);
  tar.set(header, 0);
  tar.set(bytes, 512);
  return tar;
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) {
    throw new ProviderError("tar field exceeds portable limit", "invalid_request", false);
  }
  target.set(new TextEncoder().encode(`${encoded}\0`), offset);
}
