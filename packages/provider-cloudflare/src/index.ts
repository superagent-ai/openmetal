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
  ProviderWriteFileInput,
  ProviderWriteFileResult,
  SandboxProvider,
} from "@openmetal/provider-core";

const MAX_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const MAX_FILE_BYTES = 10 * 1_024 * 1_024;

export type CloudflareSandboxProviderOptions = {
  apiUrl: string;
  apiKey: string;
  accountId?: string;
  analyticsToken?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class CloudflareRequestError extends Error {
  constructor(readonly status: number) {
    super(`Cloudflare Sandbox bridge request failed (${status})`);
  }
}

const AnalyticsGroupSchema = z.object({
  dimensions: z.object({
    instanceId: z.string(),
    region: z.string(),
  }),
  sum: z.object({
    cpuTimeSec: z.number().nonnegative(),
    allocatedMemory: z.number().nonnegative(),
    allocatedDisk: z.number().nonnegative(),
    txBytes: z.number().nonnegative(),
  }),
});

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare" as const;
  readonly capabilities: SandboxProvider["capabilities"];
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly accountId?: string;
  private readonly analyticsToken?: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly createdByMetalId = new Map<string, string>();
  private executionSequence = 0;

  constructor(options: CloudflareSandboxProviderOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.accountId = options.accountId;
    this.analyticsToken = options.analyticsToken;
    this.capabilities = {
      pause: false,
      cost: Boolean(options.accountId && options.analyticsToken),
      sizing: "fixed",
      sources: ["environment"],
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
          writeModes: ["create", "overwrite", "append"],
          createParents: false,
          list: false,
          delete: false,
          maxReadBytes: MAX_FILE_BYTES,
          maxWriteBytes: MAX_FILE_BYTES,
          maxListEntries: 1,
        },
      },
    };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("cloudflare", input.resources, input.providerOptions);
    let sandboxId = this.createdByMetalId.get(input.metalSandboxId);
    if (!sandboxId) {
      const created = z.object({ id: z.string().min(1) }).parse(
        await this.request("/v1/sandbox", {
          method: "POST",
          signal: input.signal,
        }),
      );
      sandboxId = created.id;
      this.createdByMetalId.set(input.metalSandboxId, sandboxId);
    }
    const instanceId = await this.waitUntilRunning(sandboxId, input.signal);
    return {
      providerResourceId: sandboxId,
      providerOrganizationId: new URL(this.apiUrl).host,
      providerMetadata: {
        bridgeUrl: this.apiUrl,
        containerUuid: instanceId,
        metalSandboxId: input.metalSandboxId,
      },
      resolvedResources: resolved,
    };
  }

  async pause(): Promise<void> {
    throw new Error("Cloudflare Sandboxes do not support explicit pause");
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/v1/sandbox/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    this.assertRuntimeInput("exec", input);
    if (input.command.length === 0) {
      throw new ProviderError("command must not be empty", "invalid_request", false);
    }
    if (
      input.stdin !== undefined ||
      (input.environment !== undefined && Object.keys(input.environment).length > 0)
    ) {
      throw new ProviderError(
        "Cloudflare bridge exec does not support stdin or environment overrides",
        "unsupported",
        false,
      );
    }
    const maxOutputBytes = this.limit(
      input.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    const timeoutMs = input.deadline
      ? Math.max(1, input.deadline.getTime() - Date.now())
      : this.requestTimeoutMs;
    const response = await this.bridgeResponse(
      `/v1/sandbox/${encodeURIComponent(input.providerResourceId)}/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          argv: input.command,
          timeout_ms: Math.min(timeoutMs, this.requestTimeoutMs),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }),
        signal: this.operationSignal(input),
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
      },
    );
    if (!response) {
      throw new ProviderError("Cloudflare exec response was not found", "unknown_outcome", true);
    }
    return {
      executionId: `cloudflare-${++this.executionSequence}`,
      events: this.sseExecEvents(response, input, maxOutputBytes),
    };
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    this.assertRuntimeInput("readFile", input);
    const path = bridgeWorkspacePath(input.path);
    const offsetBytes = this.limit(input.offsetBytes ?? 0, Number.MAX_SAFE_INTEGER, "offsetBytes");
    const maxBytes = this.limit(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES, "maxBytes");
    const response = await this.bridgeResponse(
      `/v1/sandbox/${encodeURIComponent(input.providerResourceId)}/file/${path}`,
      {
        method: "GET",
        signal: this.operationSignal(input),
        headers: {
          range: `bytes=${offsetBytes}-${offsetBytes + maxBytes - 1}`,
        },
      },
    );
    if (!response) {
      throw new ProviderError("Cloudflare file was not found", "invalid_request", false);
    }
    const ranged = response.status === 206;
    const contentRange = parseContentRange(response.headers.get("content-range"));
    const allBytes = await readResponseBytes(response, ranged ? maxBytes : MAX_FILE_BYTES);
    const bytes = ranged
      ? allBytes.slice(0, maxBytes)
      : allBytes.slice(offsetBytes, offsetBytes + maxBytes);
    const encoding = input.encoding ?? "binary";
    const sizeBytes = contentRange?.sizeBytes ?? allBytes.byteLength;
    const eof = offsetBytes + bytes.byteLength >= sizeBytes;
    return {
      path: input.path,
      encoding,
      data: encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes,
      offsetBytes,
      byteLength: bytes.byteLength,
      sizeBytes,
      eof,
      truncated: !eof,
    };
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    this.assertRuntimeInput("writeFile", input);
    if (input.createParents) {
      throw new ProviderError(
        "Cloudflare bridge file writes do not guarantee parent creation",
        "unsupported",
        false,
      );
    }
    const path = bridgeWorkspacePath(input.path);
    const incoming = toBytes(input.data);
    const existingResponse = await this.bridgeResponse(
      `/v1/sandbox/${encodeURIComponent(input.providerResourceId)}/file/${path}`,
      {
        method: "GET",
        signal: this.operationSignal(input),
        allowNotFound: true,
      },
    );
    const existing = existingResponse
      ? await readResponseBytes(existingResponse, MAX_FILE_BYTES)
      : null;
    if (input.mode === "create" && existing) {
      throw new ProviderError("file already exists", "invalid_request", false);
    }
    const bytes = input.mode === "append" && existing ? concatBytes(existing, incoming) : incoming;
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new ProviderError(
        `file exceeds the adapter's ${MAX_FILE_BYTES}-byte write limit`,
        "invalid_request",
        false,
      );
    }
    await this.bridgeResponse(
      `/v1/sandbox/${encodeURIComponent(input.providerResourceId)}/file/${path}`,
      {
        method: "PUT",
        body: bytes,
        signal: this.operationSignal(input),
        headers: { "content-type": "application/octet-stream" },
      },
    );
    return {
      path: input.path,
      bytesWritten: incoming.byteLength,
      created: existing === null,
    };
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    if (!this.accountId || !this.analyticsToken) {
      return null;
    }
    const query = `
      query ContainerUsage(
        $accountTag: String
        $datetimeStart: Time
        $datetimeEnd: Time
        $label: String
      ) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            usage: containersUsageAdaptiveGroups(
              limit: 100
              filter: {
                datetime_geq: $datetimeStart
                datetime_leq: $datetimeEnd
                labels_has: $label
              }
            ) {
              dimensions { instanceId region }
              sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
            }
            metrics: containersMetricsAdaptiveGroups(
              limit: 100
              filter: {
                datetime_geq: $datetimeStart
                datetime_leq: $datetimeEnd
                labels_has: $label
              }
            ) {
              dimensions { instanceId region }
              sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
            }
          }
        }
      }
    `;
    const response = await this.fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.analyticsToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: this.accountId,
          datetimeStart: input.from.toISOString(),
          datetimeEnd: input.to.toISOString(),
          label: `metal_sbx=${input.providerResourceId}`,
        },
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new CloudflareRequestError(response.status);
    }
    const parsed = z
      .object({
        data: z
          .object({
            viewer: z.object({
              accounts: z.array(
                z.object({
                  usage: z.array(AnalyticsGroupSchema),
                  metrics: z.array(AnalyticsGroupSchema),
                }),
              ),
            }),
          })
          .nullable(),
        errors: z
          .array(z.object({ message: z.string() }))
          .optional()
          .nullable(),
      })
      .parse(await response.json());
    if (parsed.errors?.length) {
      throw new Error(`Cloudflare Analytics: ${parsed.errors[0]!.message}`);
    }
    const accounts = parsed.data?.viewer.accounts ?? [];
    const usageRows = accounts.flatMap((account) => account.usage);
    const rows = usageRows.length > 0 ? usageRows : accounts.flatMap((account) => account.metrics);
    if (rows.length === 0) {
      return null;
    }
    let amountMicrousd = 0;
    for (const row of rows) {
      amountMicrousd += row.sum.cpuTimeSec * 20;
      amountMicrousd += (row.sum.allocatedMemory / 2 ** 30) * 2.5;
      amountMicrousd += (row.sum.allocatedDisk / 1_000_000_000) * 0.07;
      amountMicrousd +=
        (row.sum.txBytes / 1_000_000_000) * this.egressUsdPerGb(row.dimensions.region) * 1_000_000;
    }
    return {
      amountMicrousd: BigInt(Math.round(amountMicrousd)),
      providerOrganizationId: this.accountId,
      measuredThrough: input.to,
      provenance: usageRows.length > 0 ? "provider_metered" : "estimated_rate_card",
      confidence: usageRows.length > 0 ? "medium" : "low",
      source:
        usageRows.length > 0
          ? "cloudflare-containers-usage"
          : "cloudflare-containers-metrics-estimate",
      rateCardVersion: "2026-04-21",
      raw: {
        source:
          usageRows.length > 0
            ? "cloudflare-containers-usage"
            : "cloudflare-containers-metrics-estimate",
        rateCardVersion: "2026-04-21",
        bridgeSandboxId: input.providerResourceId,
        rows,
      },
    };
  }

  private async waitUntilRunning(sandboxId: string, callerSignal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const result = z.object({ running: z.boolean(), instanceId: z.string().min(1) }).parse(
        await this.request(`/v1/sandbox/${encodeURIComponent(sandboxId)}/running`, {
          method: "GET",
          signal: callerSignal,
        }),
      );
      if (result.running) {
        return result.instanceId;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Cloudflare Sandbox did not become ready");
  }

  private egressUsdPerGb(region: string): number {
    const normalized = region.toLowerCase();
    if (normalized.includes("nam") || normalized.includes("eur")) {
      return 0.025;
    }
    if (normalized.includes("oce") || normalized.includes("kor") || normalized.includes("twn")) {
      return 0.05;
    }
    return 0.04;
  }

  private async *sseExecEvents(
    response: Response,
    input: ProviderExecInput,
    maxOutputBytes: number,
  ): AsyncGenerator<ProviderExecEvent> {
    if (!response.body) {
      throw new ProviderError("Cloudflare exec response had no body", "unknown_outcome", true);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = 0;
    let emittedBytes = 0;
    let outputTruncated = false;
    let terminal = false;
    while (true) {
      this.assertRuntimeInput("exec", input);
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (frames.pop() ?? "");
      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === "stdout" || parsed.event === "stderr") {
          const source = decodeBase64(parsed.data);
          const remaining = Math.max(0, maxOutputBytes - emittedBytes);
          const data = source.slice(0, remaining);
          const truncated = data.byteLength < source.byteLength;
          outputTruncated ||= truncated;
          emittedBytes += data.byteLength;
          if (data.byteLength > 0) {
            yield {
              type: parsed.event,
              sequence: sequence++,
              data,
              ...(truncated ? { truncated: true } : {}),
            };
          }
        } else if (parsed.event === "exit") {
          const result = z.object({ exit_code: z.number().int() }).parse(JSON.parse(parsed.data));
          terminal = true;
          yield {
            type: "exit",
            sequence,
            exitCode: result.exit_code,
            signal: null,
            cancelled: false,
            outputTruncated,
          };
        } else if (parsed.event === "error") {
          const result = z
            .object({ error: z.string(), code: z.string().optional() })
            .parse(JSON.parse(parsed.data));
          const source = new TextEncoder().encode(
            `${result.code ? `${result.code}: ` : ""}${result.error}`,
          );
          const remaining = Math.max(0, maxOutputBytes - emittedBytes);
          const data = source.slice(0, remaining);
          outputTruncated ||= data.byteLength < source.byteLength;
          if (data.byteLength > 0) {
            yield { type: "stderr", sequence: sequence++, data };
          }
          terminal = true;
          yield {
            type: "exit",
            sequence,
            exitCode: null,
            signal: null,
            cancelled: false,
            outputTruncated,
          };
        }
      }
      if (terminal) {
        await reader.cancel();
        return;
      }
      if (done) break;
    }
    throw new ProviderError(
      "Cloudflare exec stream ended without an exit event",
      "unknown_outcome",
      true,
    );
  }

  private assertRuntimeInput(
    operation: string,
    input: { deadline?: Date; signal?: AbortSignal },
  ): void {
    if (input.signal?.aborted) {
      throw new ProviderError(`Cloudflare ${operation} aborted`, "customer", false);
    }
    if (input.deadline && input.deadline.getTime() <= Date.now()) {
      throw new ProviderError(`Cloudflare ${operation} deadline exceeded`, "timeout_absent", true);
    }
  }

  private operationSignal(input: { deadline?: Date; signal?: AbortSignal }): AbortSignal {
    this.assertRuntimeInput("runtime operation", input);
    const remaining = input.deadline
      ? input.deadline.getTime() - Date.now()
      : this.requestTimeoutMs;
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.requestTimeoutMs, remaining)));
    return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  }

  private limit(value: number, maximum: number, name: string): number {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new ProviderError(
        `${name} must be an integer between 0 and ${maximum}`,
        "invalid_request",
        false,
      );
    }
    return value;
  }

  private async bridgeResponse(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT";
      body?: RequestInit["body"];
      signal: AbortSignal;
      headers?: Record<string, string>;
      allowNotFound?: boolean;
    },
  ): Promise<Response | null> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...options.headers,
      },
      body: options.body,
      signal: options.signal,
    });
    if (options.allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new CloudflareRequestError(response.status);
    return response;
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
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
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return {};
    }
    if (!response.ok) {
      throw new CloudflareRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}

function bridgeWorkspacePath(path: string): string {
  if (
    !path.startsWith("/workspace/") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ProviderError(
      "Cloudflare bridge paths must be within /workspace",
      "invalid_request",
      false,
    );
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function parseContentRange(value: string | null): { sizeBytes: number } | null {
  const match = value ? /^bytes \d+-\d+\/(\d+)$/.exec(value) : null;
  const sizeBytes = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? { sizeBytes } : null;
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderError(
      "Cloudflare file response exceeds the read limit",
      "unsupported",
      false,
    );
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
        "Cloudflare file response exceeded the streaming read limit",
        "unsupported",
        false,
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
