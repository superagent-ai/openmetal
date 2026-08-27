import { z } from "zod";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCancelExecInput,
  ProviderCancelExecResult,
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
import { ProviderError } from "@openmetal/provider-core";

const DevboxStatusSchema = z.enum([
  "scheduled",
  "queued",
  "provisioning",
  "initializing",
  "running",
  "suspending",
  "suspended",
  "resuming",
  "failure",
  "shutdown",
]);

const DevboxSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    status: DevboxStatusSchema,
    create_time_ms: z.number(),
    end_time_ms: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.string()),
    launch_parameters: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const DevboxListSchema = z
  .object({
    devboxes: z.array(DevboxSchema),
    has_more: z.boolean(),
  })
  .passthrough();

const DevboxUsageSchema = z
  .object({
    id: z.string().min(1),
    total_active_seconds: z.number().int().nonnegative(),
    total_elapsed_seconds: z.number().int().nonnegative(),
    vcpu_seconds: z.number().int().nonnegative(),
    memory_gb_seconds: z.number().int().nonnegative(),
    disk_gb_seconds: z.number().int().nonnegative(),
    start_time_ms: z.number(),
    end_time_ms: z.number().nullable().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const AsyncExecutionSchema = z
  .object({
    devbox_id: z.string().min(1),
    execution_id: z.string().min(1),
    status: z.enum(["queued", "running", "completed"]),
    stdout: z.string().nullable().optional(),
    stderr: z.string().nullable().optional(),
    exit_status: z.number().int().nullable().optional(),
    stdout_truncated: z.boolean().nullable().optional(),
    stderr_truncated: z.boolean().nullable().optional(),
  })
  .passthrough();

const ResourceSizeSchema = z.enum(["X_SMALL", "SMALL", "MEDIUM", "LARGE", "X_LARGE", "XX_LARGE"]);
export type RunloopResourceSize = z.infer<typeof ResourceSizeSchema>;

const MAX_RUNTIME_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const MAX_RUNTIME_FILE_BYTES = 10 * 1_024 * 1_024;

const hourlyRateMicrousd: Record<RunloopResourceSize, bigint> = {
  X_SMALL: 80_600n,
  SMALL: 159_800n,
  MEDIUM: 319_500n,
  LARGE: 423_100n,
  X_LARGE: 840_700n,
  XX_LARGE: 1_676_000n,
};

export type RunloopSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  resourceSize?: RunloopResourceSize;
  blueprintId?: string;
  usageRatesMicrousd?: {
    vcpuHour: bigint;
    memoryGbHour: bigint;
    diskGbHour: bigint;
  };
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class RunloopRequestError extends Error {
  constructor(readonly status: number) {
    super(`Runloop request failed (${status})`);
  }
}

export class RunloopSandboxProvider implements SandboxProvider {
  readonly name = "runloop" as const;
  readonly capabilities = {
    pause: true,
    resume: true,
    cost: true,
    sizing: "tier",
    sources: ["environment", "provider_template"],
    runtime: {
      process: {
        exec: true,
        streams: false,
        cancel: true,
        maxOutputBytes: MAX_RUNTIME_OUTPUT_BYTES,
      },
      files: {
        read: true,
        write: true,
        writeModes: ["create", "overwrite"],
        createParents: false,
        list: false,
        delete: false,
        maxReadBytes: MAX_RUNTIME_FILE_BYTES,
        maxWriteBytes: MAX_RUNTIME_FILE_BYTES,
        maxListEntries: 0,
      },
    },
  } as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly resourceSize: RunloopResourceSize;
  private readonly blueprintId?: string;
  private readonly usageRatesMicrousd?: {
    vcpuHour: bigint;
    memoryGbHour: bigint;
    diskGbHour: bigint;
  };
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private accountId?: string;
  private readonly executions = new Map<
    string,
    { providerResourceId: string; cancelRequested: boolean }
  >();

  constructor(options: RunloopSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://api.runloop.ai").replace(/\/$/, "");
    this.resourceSize = ResourceSizeSchema.parse(options.resourceSize ?? "SMALL");
    this.blueprintId = options.blueprintId;
    this.usageRatesMicrousd = options.usageRatesMicrousd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 240_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const options = input.providerOptions ?? {};
    const resolved = resolveProviderResources("runloop", input.resources, options);
    const resourceSize = ResourceSizeSchema.parse(resolved.providerSize ?? this.resourceSize);
    const blueprintId =
      typeof options.blueprint_id === "string"
        ? options.blueprint_id
        : input.source.kind === "provider_template"
          ? input.source.template
          : this.blueprintId;
    const existing = await this.findByMetalSandboxId(input.metalSandboxId, input.signal);
    const devbox =
      existing ??
      DevboxSchema.parse(
        await this.request("/v1/devboxes", {
          method: "POST",
          body: JSON.stringify({
            name: `metal-${input.metalSandboxId}`,
            metadata: {
              "metal.organization_id": input.organizationId,
              "metal.project_id": input.projectId,
              "metal.sandbox_id": input.metalSandboxId,
            },
            ...(input.image
              ? { blueprint_name: input.image }
              : blueprintId
                ? { blueprint_id: blueprintId }
                : {}),
            launch_parameters: {
              resource_size_request: resourceSize,
              keep_alive_time_seconds: Math.min(input.ttlMinutes * 60, 172_800),
            },
          }),
          signal: input.signal,
        }),
      );
    if (devbox.status === "failure" || devbox.status === "shutdown") {
      throw new Error(`Runloop Devbox entered ${devbox.status}`);
    }
    const ready =
      devbox.status === "running"
        ? devbox
        : await this.waitForStatus(devbox.id, ["running", "failure", "shutdown"], input.signal);
    if (ready.status !== "running") {
      throw new Error(`Runloop Devbox entered ${ready.status}`);
    }
    return {
      providerResourceId: ready.id,
      providerOrganizationId: await this.resolveAccountId(input.signal),
      providerMetadata: {
        runloop: ready,
        resourceSize,
        hourlyRateMicrousd: hourlyRateMicrousd[resourceSize].toString(),
        ...(this.usageRatesMicrousd
          ? {
              usageRatesMicrousd: {
                vcpuHour: this.usageRatesMicrousd.vcpuHour.toString(),
                memoryGbHour: this.usageRatesMicrousd.memoryGbHour.toString(),
                diskGbHour: this.usageRatesMicrousd.diskGbHour.toString(),
              },
            }
          : {}),
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
        "Runloop direct HTTP execution does not support portable stdin",
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
    const command = runloopCommand(input);
    const execution = AsyncExecutionSchema.parse(
      await this.request(
        `/v1/devboxes/${encodeURIComponent(input.providerResourceId)}/execute_async`,
        {
          method: "POST",
          body: JSON.stringify({ command }),
          signal,
        },
      ),
    );
    this.executions.set(execution.execution_id, {
      providerResourceId: input.providerResourceId,
      cancelRequested: false,
    });
    return {
      executionId: execution.execution_id,
      events: this.executionEvents(
        input.providerResourceId,
        execution.execution_id,
        maxOutputBytes,
        signal,
      ),
    };
  }

  async cancelExec(input: ProviderCancelExecInput): Promise<ProviderCancelExecResult> {
    await this.killExecution(input.providerResourceId, input.executionId, runtimeSignal(input));
    const tracked = this.executions.get(input.executionId);
    if (tracked?.providerResourceId === input.providerResourceId) {
      tracked.cancelRequested = true;
    }
    return { executionId: input.executionId, cancelled: true };
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
    const response = await this.requestRaw(
      `/v1/devboxes/${encodeURIComponent(input.providerResourceId)}/download_file`,
      {
        method: "POST",
        body: JSON.stringify({ path: runloopPath(input.path) }),
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
      throw new ProviderError("file exceeds Runloop write limit", "invalid_request", false);
    }
    if (input.mode === "append") {
      throw new ProviderError(
        "Runloop upload_file does not provide atomic append",
        "unsupported",
        false,
      );
    }
    if (input.createParents) {
      throw new ProviderError(
        "Runloop upload_file does not guarantee parent creation",
        "unsupported",
        false,
      );
    }
    const path = runloopPath(input.path);
    const existed = await this.runloopFileExists(
      input.providerResourceId,
      path,
      runtimeSignal(input),
    );
    if (input.mode === "create" && existed) {
      throw new ProviderError("file already exists", "invalid_request", false);
    }
    const form = new FormData();
    form.set("path", path);
    form.set("file", new Blob([bytes]));
    await this.request(`/v1/devboxes/${encodeURIComponent(input.providerResourceId)}/upload_file`, {
      method: "POST",
      body: form,
      signal: runtimeSignal(input),
    });
    return { path: input.path, bytesWritten: bytes.byteLength, created: !existed };
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    const response = DevboxSchema.parse(
      await this.request(`/v1/devboxes/${encodeURIComponent(providerResourceId)}/suspend`, {
        method: "POST",
        signal,
      }),
    );
    if (response.status !== "suspended") {
      const suspended = await this.waitForStatus(
        providerResourceId,
        ["suspended", "failure", "shutdown"],
        signal,
      );
      if (suspended.status !== "suspended") {
        throw new Error(`Runloop Devbox entered ${suspended.status}`);
      }
    }
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    const existing = await this.findByMetalSandboxId(metalSandboxId, signal);
    if (!existing) return null;
    const ready =
      existing.status === "running"
        ? existing
        : await this.waitForStatus(existing.id, ["running", "failure", "shutdown"], signal);
    if (ready.status !== "running") return null;
    return {
      providerResourceId: ready.id,
      providerOrganizationId: await this.resolveAccountId(signal),
      providerMetadata: {
        runloop: ready,
        resourceSize: this.resourceSize,
        hourlyRateMicrousd: hourlyRateMicrousd[this.resourceSize].toString(),
      },
    };
  }

  async resume(providerResourceId: string, signal?: AbortSignal): Promise<ProviderSandbox> {
    const response = DevboxSchema.parse(
      await this.request(`/v1/devboxes/${encodeURIComponent(providerResourceId)}/resume`, {
        method: "POST",
        body: JSON.stringify({}),
        signal,
      }),
    );
    const running =
      response.status === "running"
        ? response
        : await this.waitForStatus(providerResourceId, ["running", "failure", "shutdown"], signal);
    if (running.status !== "running") {
      throw new Error(`Runloop Devbox entered ${running.status}`);
    }
    return {
      providerResourceId,
      providerOrganizationId: await this.resolveAccountId(signal),
      providerMetadata: { runloop: running, resourceSize: this.resourceSize },
    };
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    const current = await this.getDevbox(providerResourceId, signal, true);
    if (!current || current.status === "shutdown") {
      return;
    }
    await this.request(
      `/v1/devboxes/${encodeURIComponent(providerResourceId)}/shutdown?force=true`,
      {
        method: "POST",
        signal,
        allowNotFound: true,
      },
    );
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const response = await this.request(
      `/v1/devboxes/${encodeURIComponent(input.providerResourceId)}/usage`,
      {
        method: "GET",
        signal: input.signal,
        allowNotFound: true,
      },
    );
    if (!response) {
      return null;
    }
    const usage = DevboxUsageSchema.parse(response);
    const metadataRate = input.providerMetadata?.hourlyRateMicrousd;
    const rate =
      typeof metadataRate === "string" && /^\d+$/.test(metadataRate)
        ? BigInt(metadataRate)
        : hourlyRateMicrousd[this.resourceSize];
    const metadataUsageRates = input.providerMetadata?.usageRatesMicrousd;
    const usageRates =
      typeof metadataUsageRates === "object" &&
      metadataUsageRates !== null &&
      "vcpuHour" in metadataUsageRates &&
      "memoryGbHour" in metadataUsageRates &&
      "diskGbHour" in metadataUsageRates &&
      typeof metadataUsageRates.vcpuHour === "string" &&
      typeof metadataUsageRates.memoryGbHour === "string" &&
      typeof metadataUsageRates.diskGbHour === "string" &&
      /^\d+$/.test(metadataUsageRates.vcpuHour) &&
      /^\d+$/.test(metadataUsageRates.memoryGbHour) &&
      /^\d+$/.test(metadataUsageRates.diskGbHour)
        ? {
            vcpuHour: BigInt(metadataUsageRates.vcpuHour),
            memoryGbHour: BigInt(metadataUsageRates.memoryGbHour),
            diskGbHour: BigInt(metadataUsageRates.diskGbHour),
          }
        : this.usageRatesMicrousd;
    const componentCostNumerator = usageRates
      ? BigInt(usage.vcpu_seconds) * usageRates.vcpuHour +
        BigInt(usage.memory_gb_seconds) * usageRates.memoryGbHour +
        BigInt(usage.disk_gb_seconds) * usageRates.diskGbHour
      : undefined;
    return {
      amountMicrousd:
        componentCostNumerator === undefined
          ? (BigInt(usage.total_active_seconds) * rate + 1_800n) / 3_600n
          : (componentCostNumerator + 1_800n) / 3_600n,
      providerOrganizationId:
        input.providerOrganizationId ?? (await this.resolveAccountId(input.signal)),
      measuredThrough: usage.end_time_ms ? new Date(usage.end_time_ms) : input.to,
      raw: {
        source: usageRates
          ? "runloop-resource-usage-oem-rate-card"
          : "runloop-resource-usage-published-preset-rate",
        resourceSize: input.providerMetadata?.resourceSize ?? this.resourceSize,
        hourlyRateMicrousd: rate.toString(),
        usageRatesMicrousd: usageRates
          ? {
              vcpuHour: usageRates.vcpuHour.toString(),
              memoryGbHour: usageRates.memoryGbHour.toString(),
              diskGbHour: usageRates.diskGbHour.toString(),
            }
          : null,
        suspendedStorageCostIncluded: Boolean(usageRates),
        usage,
      },
    };
  }

  private async resolveAccountId(signal?: AbortSignal): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const account = z
      .object({ id: z.string().min(1) })
      .passthrough()
      .parse(
        await this.request("/v1/accounts/me", {
          method: "GET",
          signal,
        }),
      );
    this.accountId = account.id;
    return account.id;
  }

  private async *executionEvents(
    providerResourceId: string,
    executionId: string,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderExecEvent> {
    let sequence = 0;
    let emittedBytes = 0;
    let outputTruncated = false;
    try {
      const completed = await this.waitForExecution(providerResourceId, executionId, signal);
      for (const [type, output] of [
        ["stdout", completed.stdout],
        ["stderr", completed.stderr],
      ] as const) {
        if (!output) continue;
        const bytes = new TextEncoder().encode(output);
        const available = Math.max(0, maxOutputBytes - emittedBytes);
        const data = bytes.slice(0, available);
        const truncated = data.byteLength < bytes.byteLength;
        outputTruncated ||= truncated;
        emittedBytes += data.byteLength;
        if (data.byteLength > 0) {
          yield {
            type,
            sequence: sequence++,
            data,
            ...(truncated ? { truncated } : {}),
          };
        }
      }
      outputTruncated ||= Boolean(completed.stdout_truncated || completed.stderr_truncated);
      yield {
        type: "exit",
        sequence,
        exitCode: completed.exit_status ?? null,
        signal: null,
        cancelled: this.executions.get(executionId)?.cancelRequested ?? false,
        outputTruncated,
      };
    } catch (error) {
      if (signal?.aborted) {
        const recoverySignal = AbortSignal.timeout(this.requestTimeoutMs);
        await this.killExecution(providerResourceId, executionId, recoverySignal).catch(
          () => undefined,
        );
        const tracked = this.executions.get(executionId);
        if (tracked?.providerResourceId === providerResourceId) tracked.cancelRequested = true;
      }
      throw error;
    } finally {
      this.executions.delete(executionId);
    }
  }

  private async waitForExecution(
    providerResourceId: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof AsyncExecutionSchema>> {
    while (true) {
      const result = AsyncExecutionSchema.parse(
        await this.request(
          `/v1/devboxes/${encodeURIComponent(providerResourceId)}/executions/${encodeURIComponent(
            executionId,
          )}`,
          { method: "GET", signal },
        ),
      );
      if (result.status === "completed") return result;
      await abortableDelay(50, signal);
    }
  }

  private async killExecution(
    providerResourceId: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const killed = AsyncExecutionSchema.safeParse(
      await this.request(
        `/v1/devboxes/${encodeURIComponent(providerResourceId)}/executions/${encodeURIComponent(
          executionId,
        )}/kill`,
        {
          method: "POST",
          body: JSON.stringify({ kill_process_group: true }),
          signal,
        },
      ),
    );
    if (!killed.success || killed.data.status !== "completed") {
      await this.waitForExecution(providerResourceId, executionId, signal);
    }
  }

  private async runloopFileExists(
    providerResourceId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.requestRaw(
      `/v1/devboxes/${encodeURIComponent(providerResourceId)}/download_file`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
        signal,
        contentType: "application/json",
        allowNotFound: true,
        allowMissingFile: true,
      },
    );
    if (response.status === 400 || response.status === 404) return false;
    await response.body?.cancel();
    return true;
  }

  private async findByMetalSandboxId(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof DevboxSchema> | undefined> {
    let startingAfter: string | undefined;
    do {
      const query = new URLSearchParams({
        limit: "5000",
        include_total_count: "false",
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const result = DevboxListSchema.parse(
        await this.request(`/v1/devboxes?${query}`, {
          method: "GET",
          signal,
        }),
      );
      const existing = result.devboxes.find(
        (devbox) =>
          (devbox.metadata["metal.sandbox_id"] === metalSandboxId ||
            devbox.metadata.metal_sandbox_id === metalSandboxId) &&
          devbox.status !== "failure" &&
          devbox.status !== "shutdown",
      );
      if (existing) {
        return existing;
      }
      startingAfter = result.has_more ? result.devboxes.at(-1)?.id : undefined;
    } while (startingAfter);
    return undefined;
  }

  private async getDevbox(
    id: string,
    signal?: AbortSignal,
    allowNotFound = false,
  ): Promise<z.infer<typeof DevboxSchema> | null> {
    const response = await this.request(`/v1/devboxes/${encodeURIComponent(id)}`, {
      method: "GET",
      signal,
      allowNotFound,
    });
    return response ? DevboxSchema.parse(response) : null;
  }

  private async waitForStatus(
    id: string,
    statuses: Array<z.infer<typeof DevboxStatusSchema>>,
    callerSignal?: AbortSignal,
  ): Promise<z.infer<typeof DevboxSchema>> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request(
        `/v1/devboxes/${encodeURIComponent(id)}/wait_for_status`,
        {
          method: "POST",
          body: JSON.stringify({
            statuses,
            timeout_seconds: Math.min(30, Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))),
          }),
          signal: callerSignal,
          allowTimeout: true,
        },
      );
      if (response) {
        return DevboxSchema.parse(response);
      }
    }
    throw new Error("Runloop Devbox did not reach the requested status");
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string | FormData;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      allowMissingFile?: boolean;
      allowTimeout?: boolean;
    },
  ): Promise<unknown | null> {
    const response = await this.requestRaw(path, options);
    if (options.allowNotFound && response.status === 404) return null;
    if (options.allowTimeout && response.status === 408) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async requestRaw(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string | FormData;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      allowMissingFile?: boolean;
      allowTimeout?: boolean;
      accept?: string;
      contentType?: string;
    },
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: options.accept ?? "application/json",
        ...(options.contentType
          ? { "content-type": options.contentType }
          : typeof options.body === "string"
            ? { "content-type": "application/json" }
            : {}),
      },
      body: options.body,
      signal,
    });
    if (
      (options.allowNotFound && response.status === 404) ||
      (options.allowMissingFile && response.status === 400)
    ) {
      return response;
    }
    if (options.allowTimeout && response.status === 408) return response;
    if (!response.ok) {
      throw new RunloopRequestError(response.status);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function runloopCommand(input: ProviderExecInput): string {
  const command = input.command.map(shellQuote).join(" ");
  const environment = Object.entries(input.environment ?? {}).map(([key, value]) => {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new ProviderError("invalid environment variable name", "invalid_request", false);
    }
    return shellQuote(`${key}=${value}`);
  });
  const invoked = environment.length > 0 ? `env ${environment.join(" ")} ${command}` : command;
  return input.cwd ? `cd -- ${shellQuote(input.cwd)} && ${invoked}` : invoked;
}

function runloopPath(path: string): string {
  if (!path.startsWith("/") || path === "/" || path.includes("\0")) {
    throw new ProviderError(
      "Runloop file path must identify an absolute file",
      "invalid_request",
      false,
    );
  }
  return path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path.slice(1);
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
  return {
    bytes: Uint8Array.from(selected),
    sizeBytes: contentLength ?? position,
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
