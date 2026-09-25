import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderError, resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderExecEvent,
  ProviderExecInput,
  ProviderExecResult,
  ProviderReadFileInput,
  ProviderReadFileResult,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  ProviderSandboxInspection,
  ProviderDestroyResult,
  ProviderWriteFileInput,
  ProviderWriteFileResult,
  SandboxProvider,
} from "@openmetal/provider-core";
import { commandEvents, connectEnvelope, startCommandSession } from "./command-session.js";

// REST /api/v1/sandbox and gateway auth/transfer shapes follow prime-sandboxes
// at ef4d17614ebfeeb6596910240609ac694d8df3f4 (September 2026).

function normalizeSandboxFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const aliases: Record<string, string> = {
    dockerImage: "docker_image",
    cpuCores: "cpu_cores",
    memoryGB: "memory_gb",
    diskSizeGB: "disk_size_gb",
    createdAt: "created_at",
    startedAt: "started_at",
    terminatedAt: "terminated_at",
    teamId: "team_id",
    userId: "user_id",
    errorType: "error_type",
  };
  const normalized = Object.fromEntries([
    ...Object.entries(record),
    ...Object.entries(aliases)
      .filter(([camel, snake]) => record[camel] === undefined && record[snake] !== undefined)
      .map(([camel, snake]) => [camel, record[snake]]),
  ]) as Record<string, unknown>;
  for (const key of ["createdAt", "startedAt", "terminatedAt"]) {
    const timestamp = normalized[key];
    if (
      typeof timestamp === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(timestamp)
    ) {
      normalized[key] = `${timestamp}Z`;
    }
  }
  return normalized;
}

const SandboxSchema = z.preprocess(
  normalizeSandboxFields,
  z.object({
    id: z.string().min(1),
    name: z.string(),
    status: z.enum([
      "PENDING",
      "PROVISIONING",
      "RUNNING",
      "PAUSED",
      "ERROR",
      "TERMINATED",
      "TIMEOUT",
    ]),
    dockerImage: z.string(),
    cpuCores: z.number(),
    memoryGB: z.number(),
    diskSizeGB: z.number(),
    createdAt: z.string(),
    startedAt: z.string().nullable().optional(),
    terminatedAt: z.string().nullable().optional(),
    teamId: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    labels: z.array(z.string()).default([]),
    vm: z.boolean(),
    errorType: z.string().nullable().optional(),
  }),
);
type PrimeSandbox = z.infer<typeof SandboxSchema>;
const ListSchema = z.object({
  sandboxes: z.array(SandboxSchema),
  has_next: z.boolean(),
});
const AuthSchema = z.object({
  gateway_url: z.url(),
  user_ns: z.string().min(1),
  job_id: z.string().min(1),
  token: z.string().min(1),
});

const MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const MAX_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const PRICE_VALID_THROUGH = Date.parse("2026-12-23T00:00:00Z");
const RATE_CARD_VERSION = "prime-sandboxes-launch-2026-09";
const IMAGES: Record<string, string> = {
  "metal/base": "ubuntu:22.04",
  "metal/node": "node:22",
  "metal/python": "python:3.11-slim",
};

export type PrimeSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  teamId?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class PrimeSandboxProvider implements SandboxProvider {
  readonly name = "prime" as const;
  readonly capabilities = {
    pause: false,
    resume: false,
    cost: true,
    sizing: "direct",
    sources: ["environment", "oci_image", "provider_template"],
    runtime: {
      process: { exec: true, streams: false, cancel: false, maxOutputBytes: MAX_OUTPUT_BYTES },
      files: {
        read: true,
        write: true,
        writeModes: ["overwrite"],
        createParents: false,
        list: false,
        delete: false,
        maxReadBytes: MAX_FILE_BYTES,
        maxWriteBytes: MAX_FILE_BYTES,
        maxListEntries: 0,
      },
      httpEndpoints: { expose: false, revoke: false },
    },
  } as const;

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly teamId?: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PrimeSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://api.primeintellect.ai").replace(/\/$/, "");
    this.teamId = options.teamId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    if (
      input.network?.internet_access === false ||
      Array.isArray(input.network?.allow_domains) ||
      (Array.isArray(input.network?.deny_domains) && input.network.deny_domains.length > 0)
    ) {
      throw new ProviderError(
        "Prime network policy is not verified by Metal",
        "unsupported",
        false,
      );
    }
    if (
      input.features?.pty === true ||
      input.features?.pause_resume === true ||
      input.features?.computer_use === true ||
      input.features?.recording ||
      (Array.isArray(input.features?.public_ports) && input.features.public_ports.length > 0) ||
      (Array.isArray(input.features?.isolation) &&
        !input.features.isolation.some((value) => value === "vm" || value === "microvm"))
    ) {
      throw new ProviderError("Prime cannot satisfy requested features", "unsupported", false);
    }
    if (
      input.lifecycle.onRuntimeTimeout === "pause" ||
      (input.lifecycle.idleTimeoutSeconds && input.lifecycle.onIdleTimeout === "pause")
    ) {
      throw new ProviderError("Prime VM timeouts destroy rather than pause", "unsupported", false);
    }
    if (Object.keys(input.secretRefs ?? {}).length) {
      throw new ProviderError(
        "Prime adapter cannot resolve Metal secret references",
        "unsupported",
        false,
      );
    }
    if (input.source.command && !input.source.command.length) {
      throw new ProviderError("Prime start command is empty", "invalid_request", false);
    }
    const image = imageFor(input);
    const teamId =
      typeof input.providerOptions?.team_id === "string"
        ? input.providerOptions.team_id
        : this.teamId;
    const idleMinutes = input.lifecycle.idleTimeoutSeconds
      ? Math.ceil(input.lifecycle.idleTimeoutSeconds / 60)
      : undefined;
    if (idleMinutes && (idleMinutes > 1440 || idleMinutes > Math.ceil(input.ttlMinutes))) {
      throw new ProviderError(
        "Prime idle timeout exceeds lifetime or 24 hours",
        "unsupported",
        false,
      );
    }
    const cpu = Math.max(1, Math.ceil(input.resources.vcpu));
    const memoryMb = Math.max(128, Math.ceil(input.resources.memoryMb / 128) * 128);
    const diskGb = Math.max(2, Math.ceil((input.resources.diskMb ?? 5 * 1024) / 1024));
    if (cpu > 16 || memoryMb > 65_536 || diskGb > 128) {
      throw new ProviderError("Prime resource limits exceeded", "unsupported", false);
    }
    resolveProviderResources("prime", {
      vcpu: cpu,
      memoryMb,
      diskMb: diskGb * 1024,
      architecture: input.resources.architecture,
    });
    const name = primeName(input.metalSandboxId);
    const label = primeLabel(input.metalSandboxId);
    const existing = await this.findByLabel(label, input.signal);
    const sandbox =
      existing ??
      parseCreatedSandbox(
        await this.json("/api/v1/sandbox", {
          method: "POST",
          body: {
            name,
            docker_image: image,
            vm: true,
            cpu_cores: cpu,
            memory_gb: memoryMb / 1024,
            disk_size_gb: diskGb,
            timeout_minutes: Math.max(1, Math.ceil(input.ttlMinutes)),
            ...(input.lifecycle.onIdleTimeout === "destroy" && idleMinutes
              ? { idle_timeout_minutes: idleMinutes }
              : {}),
            ...(teamId ? { team_id: teamId } : {}),
            environment_vars: input.environment ?? {},
            labels: [
              label,
              `metal-org-${input.organizationId}`,
              `metal-project-${input.projectId}`,
            ],
            idempotency_key: primeKey(input.metalSandboxId),
            ...(input.source.command
              ? {
                  start_command: {
                    executable: input.source.command[0],
                    args: input.source.command.slice(1),
                  },
                }
              : {}),
          },
          signal: input.signal,
          create: true,
        }),
      );
    const ready = await this.waitForRunning(sandbox, input.signal);
    return this.asProviderSandbox(ready);
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    const existing = await this.findByLabel(primeLabel(metalSandboxId), signal);
    if (!existing) return null;
    if (existing.status === "ERROR" || existing.status === "TIMEOUT") {
      await this.destroy(existing.id, signal);
      return null;
    }
    return this.asProviderSandbox(await this.waitForRunning(existing, signal));
  }

  async inspect(id: string, signal?: AbortSignal): Promise<ProviderSandboxInspection> {
    const sandbox = await this.getSandbox(id, signal);
    if (!sandbox) return { state: "absent", providerState: null, reason: null };
    const state = {
      PENDING: "starting",
      PROVISIONING: "starting",
      RUNNING: "running",
      PAUSED: "paused",
      ERROR: "failed",
      TERMINATED: "stopped",
      TIMEOUT: "stopped",
    } as const;
    return {
      state: state[sandbox.status],
      providerState: sandbox.status,
      reason: sandbox.errorType ?? null,
    };
  }

  async pause(): Promise<void> {
    throw new ProviderError("Prime VM pause is not supported", "unsupported", false);
  }

  async destroy(id: string, signal?: AbortSignal): Promise<ProviderDestroyResult> {
    const before = await this.getSandbox(id, signal);
    await this.json(`/api/v1/sandbox/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
    return before
      ? {
          providerMetadata: {
            prime: {
              ...before,
              terminatedAt: before.terminatedAt ?? new Date().toISOString(),
            },
          },
        }
      : {};
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const sandbox = await this.getSandbox(input.providerResourceId, input.signal);
    const usage = sandbox ?? SandboxSchema.safeParse(input.providerMetadata?.prime).data;
    if (!usage?.startedAt) return null;
    const start = Date.parse(usage.startedAt);
    const end = Math.min(
      input.to.getTime(),
      usage.terminatedAt ? Date.parse(usage.terminatedAt) : Infinity,
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || end >= PRICE_VALID_THROUGH) return null;
    const seconds = BigInt(Math.max(0, Math.floor((end - start) / 1000)));
    const cpu = BigInt(Math.round(usage.cpuCores));
    const memoryMb = BigInt(Math.round(usage.memoryGB * 1024));
    const diskMb = BigInt(Math.round(usage.diskSizeGB * 1024));
    const hourlyNumerator = cpu * 20_000n * 1024n + memoryMb * 12_500n + diskMb * 200n;
    return {
      amountMicrousd: (seconds * hourlyNumerator + 1_843_200n) / 3_686_400n,
      providerOrganizationId:
        input.providerOrganizationId ?? usage.teamId ?? usage.userId ?? this.teamId ?? "prime",
      measuredThrough: new Date(end),
      provenance: "estimated_rate_card",
      confidence: "low",
      source: "prime-sandboxes-published-rate-card",
      rateCardVersion: RATE_CARD_VERSION,
      raw: {
        cumulative: true,
        seconds: seconds.toString(),
        rateCardVersion: RATE_CARD_VERSION,
        resources: {
          cpu: cpu.toString(),
          memoryMb: memoryMb.toString(),
          diskMb: diskMb.toString(),
        },
        excludes: ["credits", "discounts", "taxes"],
      },
    };
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    if (!input.command.length || input.command.some((part) => part.includes("\0"))) {
      throw new ProviderError("invalid Prime command", "invalid_request", false);
    }
    if (input.stdin !== undefined) {
      throw new ProviderError("Prime adapter does not support stdin", "unsupported", false);
    }
    const limit = bounded(input.maxOutputBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const sessionId = randomUUID();
    const auth = await this.gatewayAuth(input.providerResourceId, operationSignal(input));
    const response = await this.send(`${gatewayBase(auth)}/command_session.CommandSession/Start`, {
      method: "POST",
      signal: operationSignal(input),
      token: auth.token,
      contentType: "application/connect+proto",
      timeoutMs: input.deadline ? Math.max(1, input.deadline.getTime() - Date.now()) : 300_000,
      body: connectEnvelope(
        startCommandSession(input.command, input.cwd, input.environment, sessionId),
      ),
    });
    if (!response.body)
      throw new ProviderError("Prime command stream missing", "unknown_outcome", false);
    return { executionId: sessionId, events: this.execEvents(response.body, limit) };
  }

  private async *execEvents(
    body: ReadableStream<Uint8Array>,
    limit: number,
  ): AsyncIterable<ProviderExecEvent> {
    let sequence = 0;
    let used = 0;
    let truncated = false;
    for await (const event of commandEvents(body)) {
      if (event.type === "exit") {
        yield {
          type: "exit",
          sequence: sequence++,
          exitCode: event.exitCode,
          signal: null,
          cancelled: false,
          outputTruncated: truncated,
        };
      } else {
        const data = event.data.slice(0, Math.max(0, limit - used));
        truncated ||= data.length < event.data.length;
        used += data.length;
        if (data.length) yield { type: event.type, sequence: sequence++, data, truncated };
      }
    }
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    const path = filePath(input.path);
    const offset = bounded(input.offsetBytes ?? 0, Number.MAX_SAFE_INTEGER);
    const limit = bounded(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
    const auth = await this.gatewayAuth(input.providerResourceId, operationSignal(input));
    const query = new URLSearchParams({ path, sandbox_id: input.providerResourceId });
    const response = await this.send(`${gatewayBase(auth)}/download?${query}`, {
      method: "GET",
      token: auth.token,
      signal: operationSignal(input),
    });
    const bytes = await boundedBody(response, MAX_FILE_BYTES);
    const data = bytes.slice(offset, offset + limit);
    const encoding = input.encoding ?? "binary";
    const eof = offset + data.length >= bytes.length;
    return {
      path: input.path,
      encoding,
      data: encoding === "utf8" ? new TextDecoder("utf-8", { fatal: true }).decode(data) : data,
      offsetBytes: offset,
      byteLength: data.length,
      sizeBytes: bytes.length,
      eof,
      truncated: !eof,
    };
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    const path = filePath(input.path);
    if ((input.mode && input.mode !== "overwrite") || input.createParents) {
      throw new ProviderError(
        "Prime upload supports overwrite without parent creation",
        "unsupported",
        false,
      );
    }
    const bytes =
      typeof input.data === "string" ? new TextEncoder().encode(input.data) : input.data;
    if (bytes.length > MAX_FILE_BYTES)
      throw new ProviderError("Prime upload exceeds 16 MiB", "invalid_request", false);
    const auth = await this.gatewayAuth(input.providerResourceId, operationSignal(input));
    const query = new URLSearchParams({ path, sandbox_id: input.providerResourceId });
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(bytes)]), path.split("/").at(-1));
    const response = await this.send(`${gatewayBase(auth)}/upload?${query}`, {
      method: "POST",
      body: form,
      token: auth.token,
      signal: operationSignal(input),
    });
    const uploaded = z
      .object({ success: z.literal(true) })
      .safeParse(await response.json().catch(() => null));
    if (!uploaded.success) {
      throw new ProviderError("Prime upload outcome unknown", "unknown_outcome", false);
    }
    return { path: input.path, bytesWritten: bytes.length, created: false };
  }

  private asProviderSandbox(sandbox: PrimeSandbox): ProviderSandbox {
    if (!sandbox.vm)
      throw new ProviderError("Prime returned a non-VM sandbox", "unsupported", false);
    return {
      providerResourceId: sandbox.id,
      providerOrganizationId: sandbox.teamId ?? sandbox.userId ?? this.teamId ?? "prime",
      providerMetadata: { prime: sandbox },
      resolvedResources: {
        vcpu: sandbox.cpuCores,
        memoryMb: Math.round(sandbox.memoryGB * 1024),
        diskMb: Math.round(sandbox.diskSizeGB * 1024),
        architecture: "x86_64",
        providerSize: null,
      },
    };
  }

  private async waitForRunning(initial: PrimeSandbox, signal?: AbortSignal): Promise<PrimeSandbox> {
    const end = Date.now() + this.startupTimeoutMs;
    let current = initial;
    while (current.status === "PENDING" || current.status === "PROVISIONING") {
      if (Date.now() >= end)
        throw new ProviderError("Prime creation still pending", "unknown_outcome", false);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(500, end - Date.now()));
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      const latest = await this.getSandbox(current.id, signal);
      if (!latest) throw new ProviderError("Prime sandbox disappeared", "unknown_outcome", false);
      current = latest;
    }
    if (current.status !== "RUNNING") {
      if (current.status === "ERROR" || current.status === "TIMEOUT") {
        try {
          await this.destroy(current.id, signal);
        } catch {
          throw new ProviderError(
            "Prime failed creation cleanup is uncertain",
            "unknown_outcome",
            false,
          );
        }
      }
      throw new ProviderError(`Prime creation ended in ${current.status}`, "unavailable", false);
    }
    if (!current.vm) {
      try {
        await this.destroy(current.id, signal);
      } catch {
        throw new ProviderError("Prime non-VM cleanup is uncertain", "unknown_outcome", false);
      }
      throw new ProviderError("Prime returned a non-VM sandbox", "unsupported", false);
    }
    return current;
  }

  private async findByLabel(label: string, signal?: AbortSignal): Promise<PrimeSandbox | null> {
    for (let page = 1; page <= 100; page += 1) {
      const query = new URLSearchParams({ page: String(page), per_page: "100" });
      query.append("labels", label);
      const list = ListSchema.parse(
        await this.json(`/api/v1/sandbox?${query}`, { method: "GET", signal }),
      );
      const match = list.sandboxes.find(
        (sandbox) => sandbox.labels.includes(label) && sandbox.status !== "TERMINATED",
      );
      if (match) return match;
      if (!list.has_next) return null;
    }
    throw new ProviderError(
      "Prime sandbox lookup exceeded pagination limit",
      "unknown_outcome",
      false,
    );
  }

  private async getSandbox(id: string, signal?: AbortSignal): Promise<PrimeSandbox | null> {
    const response = await this.json(`/api/v1/sandbox/${encodeURIComponent(id)}`, {
      method: "GET",
      signal,
      allowNotFound: true,
    });
    return response ? SandboxSchema.parse(response) : null;
  }

  private async gatewayAuth(id: string, signal?: AbortSignal): Promise<z.infer<typeof AuthSchema>> {
    return AuthSchema.parse(
      await this.json(`/api/v1/sandbox/${encodeURIComponent(id)}/auth`, {
        method: "POST",
        signal,
      }),
    );
  }

  private async json(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: Record<string, unknown>;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      create?: boolean;
    },
  ): Promise<unknown | null> {
    const response = await this.send(`${this.apiUrl}${path}`, {
      method: options.method,
      signal: options.signal,
      body: options.body ? JSON.stringify(options.body) : undefined,
      contentType: "application/json",
      allowNotFound: options.allowNotFound,
      create: options.create,
    });
    if (response.status === 404) return null;
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw new ProviderError(
        "Prime returned invalid JSON",
        options.create ? "unknown_outcome" : "unavailable",
        false,
      );
    }
  }

  private async send(
    url: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: RequestInit["body"];
      signal?: AbortSignal;
      token?: string;
      contentType?: string;
      allowNotFound?: boolean;
      create?: boolean;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        body: options.body,
        signal: options.signal
          ? AbortSignal.any([
              options.signal,
              AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs),
            ])
          : AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs),
        headers: {
          authorization: `Bearer ${options.token ?? this.apiKey}`,
          ...(options.contentType ? { "content-type": options.contentType } : {}),
          ...(options.contentType === "application/connect+proto"
            ? { "connect-protocol-version": "1" }
            : {}),
        },
      });
      if (options.allowNotFound && response.status === 404) return response;
      if (!response.ok) {
        const kind =
          options.create &&
          (response.status >= 500 || response.status === 409 || response.status === 408)
            ? "unknown_outcome"
            : response.status === 401 || response.status === 403
              ? "auth"
              : response.status === 402 || response.status === 429
                ? "quota"
                : response.status === 400 || response.status === 422
                  ? "invalid_request"
                  : response.status === 409
                    ? "capacity"
                    : "unavailable";
        throw new ProviderError(
          `Prime request failed (${response.status})`,
          kind,
          kind === "unavailable",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "Prime request outcome unknown",
        options.create ? "unknown_outcome" : "unavailable",
        false,
      );
    }
  }
}

function primeKey(id: string): string {
  return createHash("sha256").update(`metal-prime:${id}`).digest("hex");
}
function parseCreatedSandbox(response: unknown): PrimeSandbox {
  const parsed = SandboxSchema.safeParse(response);
  if (!parsed.success) {
    throw new ProviderError("Prime create response is incomplete", "unknown_outcome", false);
  }
  return parsed.data;
}
function primeLabel(id: string): string {
  return `metal-${primeKey(id).slice(0, 32)}`;
}
function primeName(id: string): string {
  return `metal-${primeKey(id).slice(0, 24)}`;
}
function gatewayBase(auth: z.infer<typeof AuthSchema>): string {
  return `${auth.gateway_url.replace(/\/$/, "")}/${encodeURIComponent(auth.user_ns)}/${encodeURIComponent(auth.job_id)}`;
}
function imageFor(input: ProviderCreateSandboxInput): string {
  const image =
    input.source.kind === "environment"
      ? IMAGES[input.source.environment ?? ""]
      : input.source.kind === "oci_image"
        ? input.source.image
        : input.source.template;
  if (input.source.kind === "provider_template" && !image?.startsWith("prime/")) {
    throw new ProviderError("Prime templates require a prime/ image", "unsupported", false);
  }
  const registry = image?.split("/")[0]?.toLowerCase();
  if (
    !image ||
    image.includes("\0") ||
    image.startsWith("/") ||
    (image.includes("/") &&
      registry !== "docker.io" &&
      registry !== "index.docker.io" &&
      registry !== "registry-1.docker.io" &&
      registry !== "prime" &&
      (registry === "localhost" || registry?.includes(".") || registry?.includes(":")))
  ) {
    throw new ProviderError("Prime requires a Docker Hub or Prime image", "unsupported", false);
  }
  return image;
}
function filePath(path: string): string {
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.includes("\0") ||
    path.split("/").includes("..")
  ) {
    throw new ProviderError("invalid Prime file path", "invalid_request", false);
  }
  return path;
}
function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ProviderError("Prime operation size out of range", "invalid_request", false);
  }
  return value;
}
function operationSignal(input: {
  deadline?: Date;
  signal?: AbortSignal;
}): AbortSignal | undefined {
  if (!input.deadline) return input.signal;
  const remaining = input.deadline.getTime() - Date.now();
  if (remaining <= 0)
    throw new ProviderError("Prime operation deadline exceeded", "timeout_absent", false);
  const timeout = AbortSignal.timeout(remaining);
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
}
async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maximum)
    throw new ProviderError("Prime file exceeds read limit", "unsupported", false);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum)
        throw new ProviderError("Prime file exceeds read limit", "unsupported", false);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
