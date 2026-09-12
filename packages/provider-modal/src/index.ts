import {
  AlreadyExistsError,
  ModalClient,
  NotFoundError,
  SandboxFilesystemNotFoundError,
  type Sandbox,
} from "modal";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderDeleteFileInput,
  ProviderDeleteFileResult,
  ProviderDestroyResult,
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

const MAX_OUTPUT_BYTES = 100 * 1_024 * 1_024;
const MAX_FILE_BYTES = 10 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 10_000;
const NANOSECONDS_PER_HOUR = 3_600_000_000_000n;
// Published Modal Sandbox rates: https://modal.com/pricing?calculator=
const MODAL_RATE_CARD_VERSION = "2026-09-11";
const CPU_MICROUSD_PER_CORE_HOUR = 141_912n;
const MEMORY_MICROUSD_PER_GIB_HOUR = 24_012n;

type ModalResourceUsage = {
  cpuCoreNanosecs: number;
  memGibNanosecs: number;
  gpuNanosecs: number;
  gpuType?: string;
};

function validUsageValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseResourceUsage(value: unknown): ModalResourceUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (
    !("cpuCoreNanosecs" in value) ||
    !validUsageValue(value.cpuCoreNanosecs) ||
    !("memGibNanosecs" in value) ||
    !validUsageValue(value.memGibNanosecs) ||
    !("gpuNanosecs" in value) ||
    !validUsageValue(value.gpuNanosecs)
  ) {
    return undefined;
  }
  const gpuType =
    "gpuType" in value && typeof value.gpuType === "string" ? value.gpuType : undefined;
  return {
    cpuCoreNanosecs: value.cpuCoreNanosecs,
    memGibNanosecs: value.memGibNanosecs,
    gpuNanosecs: value.gpuNanosecs,
    ...(gpuType ? { gpuType } : {}),
  };
}

function usageFromMetadata(metadata: Record<string, unknown> | undefined) {
  const modal = metadata?.modal;
  if (!modal || typeof modal !== "object" || !("finalResourceUsage" in modal)) return undefined;
  return parseResourceUsage(modal.finalResourceUsage);
}

function estimateCostMicrousd(usage: ModalResourceUsage): bigint {
  const numerator =
    BigInt(usage.cpuCoreNanosecs) * CPU_MICROUSD_PER_CORE_HOUR +
    BigInt(usage.memGibNanosecs) * MEMORY_MICROUSD_PER_GIB_HOUR;
  return (numerator + NANOSECONDS_PER_HOUR / 2n) / NANOSECONDS_PER_HOUR;
}

function modalExecTimeoutMs(deadline: Date | undefined): number | undefined {
  if (!deadline) return undefined;
  const remaining = deadline.getTime() - Date.now();
  if (remaining < 1_000) return undefined;
  return Math.floor(remaining / 1_000) * 1_000;
}

async function withOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: Date | undefined,
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  const deadlineMs = deadline ? deadline.getTime() - Date.now() : undefined;
  if (deadlineMs !== undefined && deadlineMs <= 0) {
    throw new ProviderError("Modal operation deadline exceeded", "timeout_absent", true);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new Error("Modal operation aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (deadlineMs !== undefined) {
      timer = setTimeout(
        () =>
          reject(new ProviderError("Modal operation deadline exceeded", "timeout_absent", true)),
        deadlineMs,
      );
    }
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export type ModalProviderOptions = {
  tokenId: string;
  tokenSecret: string;
  appName?: string;
  environment?: string;
  requestTimeoutMs?: number;
  client?: ModalClient;
};

export class ModalSandboxProvider implements SandboxProvider {
  readonly name = "modal" as const;
  readonly capabilities = {
    pause: false,
    cost: true,
    sizing: "direct",
    sources: ["environment", "oci_image"],
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
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly environment?: string;

  constructor(options: ModalProviderOptions) {
    this.client =
      options.client ??
      new ModalClient({
        tokenId: options.tokenId,
        tokenSecret: options.tokenSecret,
        environment: options.environment,
        timeoutMs: options.requestTimeoutMs ?? 30_000,
      });
    this.appName = options.appName ?? "metal-sandboxes";
    this.environment = options.environment;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("modal", input.resources, input.providerOptions);
    const app = await this.client.apps.fromName(this.appName, {
      createIfMissing: true,
      environment: this.environment,
    });
    const image = this.client.images.fromRegistry(input.image ?? this.defaultImage(input.language));
    const name = `metal-${input.metalSandboxId}`;
    let sandbox;
    try {
      sandbox = await this.client.sandboxes.create(app, image, {
        name,
        cpu: resolved.vcpu / 2,
        memoryMiB: resolved.memoryMb,
        timeoutMs: input.ttlMinutes * 60_000,
        tags: {
          "metal.sandbox_id": input.metalSandboxId,
          "metal.organization_id": input.organizationId,
          "metal.project_id": input.projectId,
        },
      });
    } catch (error) {
      if (!(error instanceof AlreadyExistsError)) {
        throw error;
      }
      sandbox = await this.client.sandboxes.fromName(this.appName, name, {
        environment: this.environment,
      });
    }
    const check = await sandbox.exec(["true"]);
    const exitCode = await check.wait();
    if (exitCode !== 0) {
      throw new Error(`Modal sandbox readiness check failed (${exitCode})`);
    }
    return {
      providerResourceId: sandbox.sandboxId,
      providerOrganizationId: app.appId,
      resolvedResources: resolved,
    };
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    if (input.command.length === 0) {
      throw new ProviderError("Modal command must not be empty", "invalid_request", false);
    }
    const maxOutputBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new ProviderError("Invalid Modal output limit", "invalid_request", false);
    }
    const sandbox = await withOperation(
      this.client.sandboxes.fromId(input.providerResourceId),
      input.signal,
      input.deadline,
    );
    const execTimeoutMs = modalExecTimeoutMs(input.deadline);
    const process = await withOperation(
      sandbox.exec([...input.command], {
        mode: "binary",
        stdout: "pipe",
        stderr: "pipe",
        ...(input.cwd ? { workdir: input.cwd } : {}),
        ...(input.environment ? { env: { ...input.environment } } : {}),
        ...(execTimeoutMs ? { timeoutMs: execTimeoutMs } : {}),
      }),
      input.signal,
      input.deadline,
    );
    if (input.stdin !== undefined) {
      const bytes =
        typeof input.stdin === "string" ? new TextEncoder().encode(input.stdin) : input.stdin;
      if (bytes.length > 0) {
        await withOperation(process.stdin.writeBytes(bytes), input.signal, input.deadline);
      }
      await withOperation(process.stdin.close(), input.signal, input.deadline);
    }
    const executionId = crypto.randomUUID();
    async function* events(): AsyncGenerator<ProviderExecEvent> {
      const stdout = process.stdout.getReader();
      const stderr = process.stderr.getReader();
      let stdoutNext:
        | Promise<{
            stream: "stdout";
            result: Awaited<ReturnType<typeof stdout.read>>;
          }>
        | undefined = stdout.read().then((result) => ({ stream: "stdout", result }));
      let stderrNext:
        | Promise<{
            stream: "stderr";
            result: Awaited<ReturnType<typeof stderr.read>>;
          }>
        | undefined = stderr.read().then((result) => ({ stream: "stderr", result }));
      let sequence = 0;
      let outputBytes = 0;
      let outputTruncated = false;
      try {
        while (stdoutNext || stderrNext) {
          const next = await withOperation(
            Promise.race([
              ...(stdoutNext ? [stdoutNext] : []),
              ...(stderrNext ? [stderrNext] : []),
            ]),
            input.signal,
            input.deadline,
          );
          if (next.stream === "stdout") {
            if (next.result.done) stdoutNext = undefined;
            else stdoutNext = stdout.read().then((result) => ({ stream: "stdout", result }));
          } else if (next.result.done) {
            stderrNext = undefined;
          } else {
            stderrNext = stderr.read().then((result) => ({ stream: "stderr", result }));
          }
          if (!next.result.done) {
            const remaining = Math.max(0, maxOutputBytes - outputBytes);
            const data = next.result.value.slice(0, remaining);
            outputBytes += data.length;
            if (data.length < next.result.value.length) outputTruncated = true;
            if (data.length > 0) {
              yield {
                type: next.stream,
                sequence: sequence++,
                data,
                ...(data.length < next.result.value.length ? { truncated: true } : {}),
              };
            }
          }
        }
        const exitCode = await withOperation(process.wait(), input.signal, input.deadline);
        yield {
          type: "exit",
          sequence,
          exitCode,
          signal: null,
          cancelled: false,
          outputTruncated,
        };
      } finally {
        stdout.releaseLock();
        stderr.releaseLock();
      }
    }
    return { executionId, events: events() };
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
    const offsetBytes = input.offsetBytes ?? 0;
    if (maxBytes < 1 || maxBytes > MAX_FILE_BYTES || offsetBytes < 0) {
      throw new ProviderError("Invalid Modal file read range", "invalid_request", false);
    }
    const sandbox = await this.runtimeSandbox(
      input.providerResourceId,
      input.signal,
      input.deadline,
    );
    const info = await withOperation(
      sandbox.filesystem.stat(input.path),
      input.signal,
      input.deadline,
    );
    if (info.size > MAX_FILE_BYTES) {
      throw new ProviderError(
        "Modal readBytes cannot safely bound files larger than the adapter limit",
        "unsupported",
        false,
      );
    }
    const all = await withOperation(
      sandbox.filesystem.readBytes(input.path),
      input.signal,
      input.deadline,
    );
    if (all.byteLength > MAX_FILE_BYTES) {
      throw new ProviderError("Modal readBytes exceeded the adapter limit", "unsupported", false);
    }
    const data = all.slice(offsetBytes, offsetBytes + maxBytes);
    const eof = offsetBytes + data.length >= info.size;
    return {
      path: input.path,
      encoding: input.encoding ?? "binary",
      data: input.encoding === "utf8" ? new TextDecoder().decode(data) : data,
      offsetBytes,
      byteLength: data.length,
      sizeBytes: info.size,
      eof,
      truncated: !eof,
    };
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    const bytes =
      typeof input.data === "string" ? new TextEncoder().encode(input.data) : input.data;
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ProviderError("Modal write exceeds provider limit", "invalid_request", false);
    }
    if (input.mode === "append") {
      throw new ProviderError(
        "Modal does not natively support append writes",
        "unsupported",
        false,
      );
    }
    const sandbox = await this.runtimeSandbox(
      input.providerResourceId,
      input.signal,
      input.deadline,
    );
    const existed = await this.modalFileExists(sandbox, input.path, input.signal, input.deadline);
    if (input.mode === "create" && existed) {
      throw new ProviderError("Modal file already exists", "customer", false);
    }
    if (input.createParents === false) {
      const parent = input.path.slice(0, input.path.lastIndexOf("/")) || "/";
      if (!(await this.modalFileExists(sandbox, parent, input.signal, input.deadline))) {
        throw new ProviderError("Modal parent directory does not exist", "customer", false);
      }
    }
    await withOperation(
      sandbox.filesystem.writeBytes(bytes, input.path),
      input.signal,
      input.deadline,
    );
    return { path: input.path, bytesWritten: bytes.length, created: !existed };
  }

  async listFiles(input: ProviderListFilesInput): Promise<ProviderListFilesResult> {
    const maxEntries = input.maxEntries ?? MAX_LIST_ENTRIES;
    if (maxEntries < 1 || maxEntries > MAX_LIST_ENTRIES) {
      throw new ProviderError("Invalid Modal list limit", "invalid_request", false);
    }
    const sandbox = await this.runtimeSandbox(
      input.providerResourceId,
      input.signal,
      input.deadline,
    );
    const pending = [input.path];
    const entries: ProviderFileEntry[] = [];
    while (pending.length > 0 && entries.length <= maxEntries) {
      const directory = pending.shift()!;
      const listed = await withOperation(
        sandbox.filesystem.listFiles(directory),
        input.signal,
        input.deadline,
      );
      for (const entry of listed) {
        entries.push({
          path: entry.path,
          type: entry.type,
          sizeBytes: entry.size,
          modifiedAt: new Date(entry.modifiedTime * 1_000),
        });
        if (input.recursive && entry.type === "directory") pending.push(entry.path);
        if (entries.length > maxEntries) break;
      }
    }
    return {
      entries: entries.slice(0, maxEntries),
      truncated: entries.length > maxEntries || pending.length > 0,
    };
  }

  async deleteFile(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult> {
    const sandbox = await this.runtimeSandbox(
      input.providerResourceId,
      input.signal,
      input.deadline,
    );
    try {
      await withOperation(
        sandbox.filesystem.remove(input.path, { recursive: input.recursive ?? false }),
        input.signal,
        input.deadline,
      );
      return { path: input.path, deleted: true };
    } catch (error) {
      if (error instanceof SandboxFilesystemNotFoundError) {
        return { path: input.path, deleted: false };
      }
      throw error;
    }
  }

  async destroy(
    providerResourceId: string,
    signal?: AbortSignal,
  ): Promise<ProviderDestroyResult | void> {
    try {
      const sandbox = await withOperation(
        this.client.sandboxes.fromId(providerResourceId),
        signal,
        undefined,
      );
      let finalResourceUsage: ModalResourceUsage | undefined;
      try {
        finalResourceUsage = await this.getResourceUsage(providerResourceId, signal);
      } catch {
        // Cleanup must proceed even if Modal cannot return a final usage measurement.
      }
      await withOperation(sandbox.terminate(), signal, undefined);
      return finalResourceUsage
        ? {
            providerMetadata: {
              modal: { finalResourceUsage },
            },
          }
        : undefined;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
  }

  async pause(): Promise<void> {
    throw new Error("Modal sandboxes do not support pause");
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const usage =
      usageFromMetadata(input.providerMetadata) ??
      (await this.getResourceUsage(input.providerResourceId, input.signal));
    if (usage.gpuNanosecs > 0) {
      throw new ProviderError(
        "Modal GPU usage cannot be priced by the CPU sandbox rate card",
        "unsupported",
        false,
      );
    }
    return {
      amountMicrousd: estimateCostMicrousd(usage),
      providerOrganizationId: input.providerOrganizationId ?? this.appName,
      measuredThrough: input.to,
      provenance: "provider_metered",
      confidence: "medium",
      source: "modal-sandbox-resource-usage-published-rate-card",
      rateCardVersion: MODAL_RATE_CARD_VERSION,
      raw: {
        cumulative: true,
        excludes: ["credits", "discounts", "regional_modifiers"],
        rateCardVersion: MODAL_RATE_CARD_VERSION,
        usage: {
          cpuCoreNanosecs: usage.cpuCoreNanosecs.toString(),
          memGibNanosecs: usage.memGibNanosecs.toString(),
          gpuNanosecs: usage.gpuNanosecs.toString(),
          gpuType: usage.gpuType ?? null,
        },
        ratesMicrousdPerHour: {
          cpuCore: CPU_MICROUSD_PER_CORE_HOUR.toString(),
          memoryGib: MEMORY_MICROUSD_PER_GIB_HOUR.toString(),
        },
      },
    };
  }

  private async getResourceUsage(
    providerResourceId: string,
    signal?: AbortSignal,
  ): Promise<ModalResourceUsage> {
    const usage = await withOperation(
      this.client.cpClient.sandboxGetResourceUsage({ sandboxId: providerResourceId }),
      signal,
      undefined,
    );
    const parsed = parseResourceUsage(usage);
    if (!parsed) {
      throw new ProviderError("Modal returned invalid sandbox resource usage", "unavailable", true);
    }
    return parsed;
  }

  private runtimeSandbox(
    providerResourceId: string,
    signal: AbortSignal | undefined,
    deadline: Date | undefined,
  ): Promise<Sandbox> {
    return withOperation(this.client.sandboxes.fromId(providerResourceId), signal, deadline);
  }

  private async modalFileExists(
    sandbox: Sandbox,
    path: string,
    signal: AbortSignal | undefined,
    deadline: Date | undefined,
  ): Promise<boolean> {
    try {
      await withOperation(sandbox.filesystem.stat(path), signal, deadline);
      return true;
    } catch (error) {
      if (error instanceof SandboxFilesystemNotFoundError) return false;
      throw error;
    }
  }

  private defaultImage(language: string): string {
    if (language === "python") {
      return "python:3.13-slim";
    }
    return "node:22-slim";
  }
}
