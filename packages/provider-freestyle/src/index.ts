import { createHash } from "node:crypto";
import { Freestyle, FreestyleApiError } from "freestyle";
import type { ExecResult, FileStat, ListVmsResult, VmData, VmState } from "freestyle";
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

const DEFAULT_SNAPSHOT_ID = "freestyle/ubuntu-sm";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const MAX_FILE_BYTES = 10 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 10_000;
const MAX_STDIN_BYTES = 1 * 1_024 * 1_024;
const MAX_EXEC_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 200;
const RATE_CARD_VERSION = "2026-09-10";
const VCPU_MICROUSD_PER_HOUR = 40_320n;
const MEMORY_GIB_MICROUSD_PER_HOUR = 12_900n;
const STORAGE_GIB_MICROUSD_PER_HOUR = 86n;
const MIB_PER_GIB = 1_024n;
const SECONDS_PER_HOUR = 3_600n;

type FreestyleTransport = Pick<Freestyle, "fetch">;
type JsonRecord = Record<string, unknown>;

type FinalUsage = {
  createdAt: string;
  destroyedAt?: string;
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  snapshotId?: string | null;
  totalRunSeconds: number;
};

export type FreestyleSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  /** Alias for the Freestyle API base URL, matching the CLI's --proxy option. */
  proxy?: string;
  snapshotId?: string;
  accountId?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  client?: FreestyleTransport;
};

export class FreestyleSandboxProvider implements SandboxProvider {
  readonly name = "freestyle" as const;
  readonly capabilities = {
    pause: true,
    resume: true,
    cost: true,
    sizing: "template",
    sources: ["environment", "provider_template"],
    runtime: {
      process: {
        exec: true,
        streams: false,
        cancel: false,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      },
      files: {
        read: true,
        write: true,
        writeModes: ["overwrite"],
        createParents: true,
        list: true,
        delete: true,
        maxReadBytes: MAX_FILE_BYTES,
        maxWriteBytes: MAX_FILE_BYTES,
        maxListEntries: MAX_LIST_ENTRIES,
      },
      httpEndpoints: {
        expose: false,
        revoke: false,
      },
    },
  } as const;

  private readonly client: FreestyleTransport;
  private readonly snapshotId: string;
  private readonly accountId: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;

  constructor(options: FreestyleSandboxProviderOptions) {
    this.snapshotId = options.snapshotId ?? DEFAULT_SNAPSHOT_ID;
    this.accountId = options.accountId ?? "freestyle";
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.startupTimeoutMs = positiveTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.client =
      options.client ??
      new Freestyle({
        apiKey: options.apiKey,
        ...(options.apiUrl || options.proxy ? { baseUrl: options.apiUrl ?? options.proxy } : {}),
        ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      });
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    try {
      if (input.source.kind === "oci_image") {
        throw new ProviderError(
          "Freestyle does not support OCI image sources",
          "unsupported",
          false,
        );
      }
      const snapshotId =
        input.source.kind === "provider_template"
          ? input.source.template
          : typeof input.providerOptions?.snapshot_id === "string"
            ? input.providerOptions.snapshot_id
            : this.snapshotId;
      if (!snapshotId) {
        throw new ProviderError("Freestyle snapshot id is required", "invalid_request", false);
      }
      if (input.resources.architecture === "arm64") {
        throw new ProviderError("Freestyle arm64 support is not verified", "unsupported", false);
      }

      const slug = freestyleSlug(input.metalSandboxId);
      const metadata = metadataTags(input);
      const createBody = {
        snapshotId,
        slug,
        metadata,
        firewall: {
          rules: [{ action: "allow", source: {}, destination: { public: true } }],
        },
        ttlSeconds: Math.max(1, Math.floor(input.ttlMinutes * 60)),
        ...(input.lifecycle.onRuntimeTimeout === "pause"
          ? { maxRunSeconds: Math.max(1, Math.floor(input.lifecycle.runtimeTimeoutSeconds)) }
          : {}),
        ...(input.lifecycle.idleTimeoutSeconds !== undefined &&
        input.lifecycle.onIdleTimeout === "pause"
          ? { idleTimeoutSeconds: Math.max(1, Math.floor(input.lifecycle.idleTimeoutSeconds)) }
          : {}),
      };

      let vm: VmData;
      try {
        vm = parseVmData(
          await this.requestJson("/v5/vms", {
            method: "POST",
            body: JSON.stringify(createBody),
            signal: input.signal,
          }),
        );
      } catch (error) {
        if (!isCreateReconciliationCandidate(error)) throw error;
        const reconciled = await this.findByMetalId(input.metalSandboxId, input.signal);
        if (!reconciled) throw error;
        vm = reconciled;
      }

      try {
        vm = await this.waitForState(vm.id, ["running"], input.signal);
        const resize = {
          ...(input.resources.vcpu > vm.resources.cpu ? { cpu: input.resources.vcpu } : {}),
          ...(input.resources.memoryMb > vm.resources.memory
            ? { memory: input.resources.memoryMb }
            : {}),
          ...(input.resources.diskMb !== undefined && input.resources.diskMb > vm.resources.storage
            ? { storage: input.resources.diskMb }
            : {}),
        };
        if (Object.keys(resize).length > 0) {
          vm = parseVmData(
            await this.requestJson(`/v5/vms/${segment(vm.id)}/resize`, {
              method: "POST",
              body: JSON.stringify(resize),
              signal: input.signal,
            }),
          );
        }
        return this.toProviderSandbox(vm, snapshotId, slug);
      } catch (error) {
        try {
          await this.requestJson(`/v5/vms/${segment(vm.id)}`, {
            method: "DELETE",
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
        } catch (cleanupError) {
          if (!isNotFound(cleanupError)) {
            throw new AggregateError(
              [error, cleanupError],
              "Freestyle post-create setup and cleanup both failed",
            );
          }
        }
        throw error;
      }
    } catch (error) {
      throw mapProviderError(error, "create");
    }
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    try {
      const vm = await this.findByMetalId(metalSandboxId, signal);
      if (!vm) return null;
      return this.toProviderSandbox(
        vm,
        vm.sourceSnapshotSlugAtCreate ?? vm.snapshotId ?? this.snapshotId,
        freestyleSlug(metalSandboxId),
      );
    } catch (error) {
      throw mapProviderError(error, "read");
    }
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    try {
      let vm = await this.getVm(providerResourceId, signal);
      if (vm.state === "paused" || vm.state === "stopped") return;
      if (vm.state === "pausing") {
        await this.waitForState(vm.id, ["paused", "stopped"], signal);
        return;
      }
      if (vm.state === "starting") {
        vm = await this.waitForState(vm.id, ["running"], signal);
      }
      if (vm.state === "running") {
        await this.requestJson(`/v5/vms/${segment(vm.id)}/pause`, {
          method: "POST",
          body: "{}",
          signal,
        });
        await this.waitForState(vm.id, ["paused", "stopped"], signal);
      }
    } catch (error) {
      throw mapProviderError(error, "mutation");
    }
  }

  async resume(providerResourceId: string, signal?: AbortSignal): Promise<ProviderSandbox> {
    try {
      let vm = await this.getVm(providerResourceId, signal);
      if (vm.state !== "running") {
        if (vm.state !== "starting") {
          vm = parseVmData(
            await this.requestJson(`/v5/vms/${segment(vm.id)}/start`, {
              method: "POST",
              body: "{}",
              signal,
            }),
          );
        }
        if (vm.state !== "running") {
          vm = await this.waitForState(vm.id, ["running"], signal);
        }
      }
      return this.toProviderSandbox(
        vm,
        vm.sourceSnapshotSlugAtCreate ?? vm.snapshotId ?? this.snapshotId,
        vm.slug ?? providerResourceId,
      );
    } catch (error) {
      throw mapProviderError(error, "mutation");
    }
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<ProviderDestroyResult> {
    try {
      let vm: VmData | undefined;
      try {
        vm = await this.getVm(providerResourceId, signal);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!vm) return {};

      const destroyedAt = new Date().toISOString();
      const finalUsage = usageFromVm(vm, destroyedAt);
      try {
        await this.requestJson(`/v5/vms/${segment(providerResourceId)}`, {
          method: "DELETE",
          signal,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return {
        providerMetadata: {
          freestyle: finalUsage,
        },
      };
    } catch (error) {
      throw mapProviderError(error, "mutation");
    }
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    try {
      if (input.command.length === 0) {
        throw new ProviderError("Freestyle command must not be empty", "invalid_request", false);
      }
      const maxOutputBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES;
      if (
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1 ||
        maxOutputBytes > MAX_OUTPUT_BYTES
      ) {
        throw new ProviderError("Invalid Freestyle output limit", "invalid_request", false);
      }
      const stdin =
        input.stdin === undefined
          ? undefined
          : typeof input.stdin === "string"
            ? new TextEncoder().encode(input.stdin)
            : input.stdin;
      if (stdin && stdin.byteLength > MAX_STDIN_BYTES) {
        throw new ProviderError("Freestyle stdin exceeds 1 MiB", "invalid_request", false);
      }
      for (const key of Object.keys(input.environment ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new ProviderError(
            `Invalid Freestyle environment variable name: ${key}`,
            "invalid_request",
            false,
          );
        }
      }

      const timeoutMs = nativeExecTimeout(input.deadline);
      const result = parseExecResult(
        await this.requestJson(`/v5/vms/${segment(input.providerResourceId)}/exec-await`, {
          method: "POST",
          body: JSON.stringify({
            command: shellCommand(input.command, input.cwd),
            timeoutMs,
            ...(input.environment ? { env: input.environment } : {}),
            ...(stdin ? { stdin: Buffer.from(stdin).toString("base64") } : {}),
          }),
          signal: input.signal,
          deadline: input.deadline,
          timeoutMs,
        }),
      );
      const executionId = crypto.randomUUID();
      return {
        executionId,
        events: bufferedEvents(result, maxOutputBytes),
      };
    } catch (error) {
      throw mapProviderError(error, "exec");
    }
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    try {
      const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
      const offsetBytes = input.offsetBytes ?? 0;
      validateReadRange(offsetBytes, maxBytes);
      const stat = await this.stat(input.providerResourceId, input.path, input);
      if (!stat.isFile) {
        throw new ProviderError("Freestyle path is not a file", "customer", false);
      }
      if (offsetBytes >= stat.size) {
        return {
          path: input.path,
          encoding: input.encoding ?? "binary",
          data: input.encoding === "utf8" ? "" : new Uint8Array(),
          offsetBytes,
          byteLength: 0,
          sizeBytes: stat.size,
          eof: true,
          truncated: false,
        };
      }
      const response = await this.requestResponse(
        `/v5/vms/${segment(input.providerResourceId)}/fs/read?path=${encodeURIComponent(input.path)}`,
        {
          method: "GET",
          headers: { range: `bytes=${offsetBytes}-${offsetBytes + maxBytes - 1}` },
          signal: input.signal,
          deadline: input.deadline,
        },
      );
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > maxBytes) {
        throw new ProviderError("Freestyle ranged read exceeded its limit", "unsupported", false);
      }
      const eof = offsetBytes + data.byteLength >= stat.size;
      return {
        path: input.path,
        encoding: input.encoding ?? "binary",
        data: input.encoding === "utf8" ? new TextDecoder().decode(data) : data,
        offsetBytes,
        byteLength: data.byteLength,
        sizeBytes: stat.size,
        eof,
        truncated: !eof,
      };
    } catch (error) {
      throw mapProviderError(error, "read");
    }
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    try {
      if (input.mode === "create" || input.mode === "append") {
        throw new ProviderError(
          `Freestyle does not support ${input.mode} write mode`,
          "unsupported",
          false,
        );
      }
      const bytes =
        typeof input.data === "string" ? new TextEncoder().encode(input.data) : input.data;
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new ProviderError("Freestyle write exceeds 10 MiB", "invalid_request", false);
      }
      const existed = await this.exists(input.providerResourceId, input.path, input);
      const parent = parentPath(input.path);
      if (input.createParents === true) {
        await this.requestJson(`/v5/vms/${segment(input.providerResourceId)}/fs/mkdir`, {
          method: "POST",
          body: JSON.stringify({ path: parent }),
          signal: input.signal,
          deadline: input.deadline,
        });
      } else if (!(await this.exists(input.providerResourceId, parent, input))) {
        throw new ProviderError("Freestyle parent directory does not exist", "customer", false);
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await this.requestJson(
        `/v5/vms/${segment(input.providerResourceId)}/fs/write?path=${encodeURIComponent(input.path)}&sha256=${sha256}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
          signal: input.signal,
          deadline: input.deadline,
        },
      );
      return { path: input.path, bytesWritten: bytes.byteLength, created: !existed };
    } catch (error) {
      throw mapProviderError(error, "mutation");
    }
  }

  async listFiles(input: ProviderListFilesInput): Promise<ProviderListFilesResult> {
    try {
      const maxEntries = input.maxEntries ?? MAX_LIST_ENTRIES;
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_LIST_ENTRIES) {
        throw new ProviderError("Invalid Freestyle list limit", "invalid_request", false);
      }
      const entries: ProviderFileEntry[] = [];
      const directories = [normalizePath(input.path)];
      let truncated = false;
      while (directories.length > 0 && !truncated) {
        const directory = directories.shift();
        if (!directory) break;
        const children = parseDirEntries(
          await this.requestJson(
            `/v5/vms/${segment(input.providerResourceId)}/fs/dir?path=${encodeURIComponent(directory)}`,
            {
              method: "GET",
              signal: input.signal,
              deadline: input.deadline,
            },
          ),
        );
        for (const child of children) {
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          const path = joinPath(directory, child.name);
          const stat = await this.stat(input.providerResourceId, path, input);
          const entry = fileEntry(path, stat, child.kind);
          entries.push(entry);
          if (input.recursive && entry.type === "directory") directories.push(path);
        }
      }
      return { entries, truncated };
    } catch (error) {
      throw mapProviderError(error, "read");
    }
  }

  async deleteFile(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult> {
    try {
      if (!(await this.exists(input.providerResourceId, input.path, input))) {
        return { path: input.path, deleted: false };
      }
      const stat = await this.stat(input.providerResourceId, input.path, input);
      if (stat.isDirectory && !input.recursive) {
        const children = parseDirEntries(
          await this.requestJson(
            `/v5/vms/${segment(input.providerResourceId)}/fs/dir?path=${encodeURIComponent(input.path)}`,
            {
              method: "GET",
              signal: input.signal,
              deadline: input.deadline,
            },
          ),
        );
        if (children.length > 0) {
          throw new ProviderError(
            "Freestyle directory is not empty; recursive deletion is required",
            "customer",
            false,
          );
        }
      }
      try {
        await this.requestJson(
          `/v5/vms/${segment(input.providerResourceId)}/fs/remove?path=${encodeURIComponent(input.path)}`,
          {
            method: "DELETE",
            signal: input.signal,
            deadline: input.deadline,
          },
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
        return { path: input.path, deleted: false };
      }
      return { path: input.path, deleted: true };
    } catch (error) {
      throw mapProviderError(error, "mutation");
    }
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    try {
      let usage: FinalUsage | undefined;
      let source = "freestyle-current-vm-rate-card";
      try {
        const vm = await this.getVm(input.providerResourceId, input.signal);
        usage = usageFromVm(vm);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        usage = finalUsageFromMetadata(input.providerMetadata);
        source = "freestyle-destroy-metadata-rate-card";
      }
      if (!usage) return null;

      const end = usage.destroyedAt
        ? new Date(Math.min(input.to.getTime(), Date.parse(usage.destroyedAt)))
        : input.to;
      const storageSeconds = Math.max(
        0,
        Math.floor((end.getTime() - Date.parse(usage.createdAt)) / 1_000),
      );
      const amountMicrousd = estimateCostMicrousd(
        usage.totalRunSeconds,
        storageSeconds,
        usage.resources,
      );
      return {
        amountMicrousd,
        providerOrganizationId: input.providerOrganizationId ?? this.accountId,
        measuredThrough: end,
        provenance: "estimated_rate_card",
        confidence: "low",
        source,
        rateCardVersion: RATE_CARD_VERSION,
        raw: {
          cumulative: true,
          excludes: ["transfer", "plan_credits", "discounts"],
          rateCardVersion: RATE_CARD_VERSION,
          totalRunSeconds: usage.totalRunSeconds,
          storageSeconds,
          resources: usage.resources,
          ratesMicrousdPerHour: {
            vcpu: VCPU_MICROUSD_PER_HOUR.toString(),
            memoryGib: MEMORY_GIB_MICROUSD_PER_HOUR.toString(),
            storageGib: STORAGE_GIB_MICROUSD_PER_HOUR.toString(),
          },
          usageSource: usage.destroyedAt ? "destroy_metadata" : "current_vm",
        },
      };
    } catch (error) {
      throw mapProviderError(error, "read");
    }
  }

  private async findByMetalId(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<VmData | undefined> {
    const slug = freestyleSlug(metalSandboxId);
    const response = parseListVms(
      await this.requestJson(`/v5/vms?slug=${encodeURIComponent(slug)}&limit=100`, {
        method: "GET",
        signal,
      }),
    );
    const taggedId = metadataValue(metalSandboxId);
    return response.vms.find(
      (vm) => vm.slug === slug && vm.metadata["metal.sandbox_id"] === taggedId,
    );
  }

  private async getVm(providerResourceId: string, signal?: AbortSignal): Promise<VmData> {
    return parseVmData(
      await this.requestJson(`/v5/vms/${segment(providerResourceId)}`, {
        method: "GET",
        signal,
      }),
    );
  }

  private async waitForState(
    providerResourceId: string,
    targets: readonly VmState[],
    signal?: AbortSignal,
  ): Promise<VmData> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() <= deadline) {
      const vm = await this.getVm(providerResourceId, signal);
      if (targets.includes(vm.state)) return vm;
      signal?.throwIfAborted();
      await abortableDelay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), signal);
    }
    throw new ProviderError(
      `Freestyle VM did not reach ${targets.join(" or ")} before startup timeout`,
      "timeout_absent",
      true,
    );
  }

  private toProviderSandbox(vm: VmData, snapshotId: string, slug: string): ProviderSandbox {
    return {
      providerResourceId: vm.id,
      providerOrganizationId: this.accountId,
      providerMetadata: {
        freestyle: {
          slug,
          snapshotId: vm.snapshotId ?? snapshotId,
          sourceSnapshotSlugAtCreate: vm.sourceSnapshotSlugAtCreate,
          createdAt: vm.createdAt,
          totalRunSeconds: vm.totalRunSeconds ?? 0,
          resources: vm.resources,
        },
      },
      resolvedResources: {
        vcpu: vm.resources.cpu,
        memoryMb: vm.resources.memory,
        diskMb: vm.resources.storage,
        architecture: "x86_64",
        providerSize: vm.sourceSnapshotSlugAtCreate ?? snapshotId,
      },
    };
  }

  private async exists(
    providerResourceId: string,
    path: string,
    operation: { signal?: AbortSignal; deadline?: Date },
  ): Promise<boolean> {
    const response = asRecord(
      await this.requestJson(
        `/v5/vms/${segment(providerResourceId)}/fs/exists?path=${encodeURIComponent(path)}`,
        {
          method: "GET",
          signal: operation.signal,
          deadline: operation.deadline,
        },
      ),
    );
    if (typeof response?.exists !== "boolean") {
      throw new Error("Freestyle path existence response was invalid");
    }
    return response.exists;
  }

  private async stat(
    providerResourceId: string,
    path: string,
    operation: { signal?: AbortSignal; deadline?: Date },
  ): Promise<FileStat> {
    return parseFileStat(
      await this.requestJson(
        `/v5/vms/${segment(providerResourceId)}/fs/stat?path=${encodeURIComponent(path)}`,
        {
          method: "GET",
          signal: operation.signal,
          deadline: operation.deadline,
        },
      ),
    );
  }

  private async requestJson(
    path: string,
    init: RequestInit & { deadline?: Date; timeoutMs?: number },
  ): Promise<unknown> {
    const response = await this.requestResponse(path, init);
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private async requestResponse(
    path: string,
    init: RequestInit & { deadline?: Date; timeoutMs?: number },
  ): Promise<Response> {
    const { deadline, timeoutMs, ...requestInit } = init;
    const operation = operationSignal(
      requestInit.signal as AbortSignal | undefined,
      deadline,
      timeoutMs ?? this.requestTimeoutMs,
    );
    try {
      const headers = new Headers(requestInit.headers);
      if (requestInit.body && !(requestInit.body instanceof Uint8Array)) {
        headers.set("content-type", "application/json");
      }
      const response = await this.client.fetch(path, {
        ...requestInit,
        headers,
        signal: operation.signal,
      });
      if (response.status === 202) {
        throw new FreestyleApiError(
          202,
          {
            code: "BACKGROUND_REQUEST_UNRESOLVED",
            message: "Freestyle accepted the request without a terminal response",
          },
          path,
        );
      }
      if (!response.ok) throw await freestyleError(response, path);
      return response;
    } finally {
      operation.cleanup();
    }
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProviderError(
      "Freestyle timeout must be a positive integer",
      "invalid_request",
      false,
    );
  }
  return value;
}

function operationSignal(
  callerSignal: AbortSignal | undefined,
  deadline: Date | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const remaining = deadline ? deadline.getTime() - Date.now() : Number.POSITIVE_INFINITY;
  if (remaining <= 0) {
    callerSignal?.removeEventListener("abort", abortFromCaller);
    throw new ProviderError("Freestyle operation deadline expired", "timeout_absent", true);
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException("Freestyle request timed out", "TimeoutError")),
    Math.min(timeoutMs, remaining),
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function freestyleError(response: Response, path: string): Promise<FreestyleApiError> {
  const text = await response.text();
  let code = "UNKNOWN_ERROR";
  let message = response.statusText || `Freestyle request failed (${response.status})`;
  if (text) {
    try {
      const body = JSON.parse(text) as JsonRecord;
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
      message = text;
    }
  }
  return new FreestyleApiError(response.status, { code, message }, path);
}

function mapProviderError(
  error: unknown,
  operation: "create" | "exec" | "mutation" | "read",
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof FreestyleApiError) {
    const code = error.code.toUpperCase();
    if (error.status === 401 || error.status === 403 || /AUTH|TOKEN|CREDENTIAL/.test(code)) {
      return new ProviderError(error.message, "auth", false);
    }
    if (
      error.status === 402 ||
      error.status === 429 ||
      /QUOTA|BILLING|PLAN_LIMIT|RATE_LIMIT/.test(code)
    ) {
      return new ProviderError(error.message, "quota", error.status === 429);
    }
    if (/CAPACITY|PLACEMENT|NO_HOST|RESOURCE_EXHAUSTED/.test(code)) {
      return new ProviderError(error.message, "capacity", true);
    }
    if (error.status === 408 || error.status === 504 || /TIMEOUT/.test(code)) {
      return new ProviderError(
        error.message,
        operation === "create" ? "unknown_outcome" : "timeout_absent",
        true,
      );
    }
    if (error.status === 202) {
      return new ProviderError(error.message, "unknown_outcome", true);
    }
    if (error.status >= 500) {
      return new ProviderError(error.message, "unavailable", true);
    }
    if (error.status === 400 || error.status === 422) {
      return new ProviderError(error.message, "invalid_request", false);
    }
    if (error.status === 404 || error.status === 409) {
      return new ProviderError(error.message, "customer", false);
    }
    return new ProviderError(error.message, "unavailable", true);
  }
  if (isAbortError(error)) {
    return new ProviderError(
      error instanceof Error ? error.message : "Freestyle operation timed out",
      operation === "create" ? "unknown_outcome" : "timeout_absent",
      true,
    );
  }
  return new ProviderError(
    error instanceof Error ? error.message : "Unknown Freestyle provider error",
    operation === "create" ? "unknown_outcome" : "unavailable",
    true,
  );
}

function isCreateReconciliationCandidate(error: unknown): boolean {
  return (
    (error instanceof FreestyleApiError &&
      (error.status === 202 ||
        error.status === 408 ||
        error.status === 409 ||
        error.status >= 500)) ||
    isAbortError(error) ||
    error instanceof TypeError
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof FreestyleApiError && error.status === 404;
}

function freestyleSlug(metalSandboxId: string): string {
  const normalized = metalSandboxId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  const hash = createHash("sha256").update(metalSandboxId).digest("hex").slice(0, 10);
  const stem = (normalized || "sandbox").slice(0, 46).replace(/-$/g, "");
  return `metal-${stem}-${hash}`;
}

function metadataTags(input: ProviderCreateSandboxInput): Record<string, string> {
  const provided = Object.fromEntries(
    Object.entries(input.metadata ?? {}).map(([key, value]) => [
      metadataValue(key),
      metadataValue(value),
    ]),
  );
  return {
    ...provided,
    "metal.sandbox_id": metadataValue(input.metalSandboxId),
    "metal.organization_id": metadataValue(input.organizationId),
    "metal.project_id": metadataValue(input.projectId),
  };
}

function metadataValue(value: string): string {
  if (value.length <= 63) return value;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${value.slice(0, 52)}-${hash}`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(command: readonly string[], cwd?: string): string {
  const invoked = command.map(shellQuote).join(" ");
  return cwd ? `cd -- ${shellQuote(cwd)} && ${invoked}` : invoked;
}

function nativeExecTimeout(deadline?: Date): number {
  if (!deadline) return MAX_EXEC_TIMEOUT_MS;
  const remaining = deadline.getTime() - Date.now();
  if (remaining <= 0) {
    throw new ProviderError("Freestyle exec deadline expired", "timeout_absent", true);
  }
  return Math.max(1, Math.min(MAX_EXEC_TIMEOUT_MS, Math.floor(remaining)));
}

async function* bufferedEvents(
  result: ExecResult,
  maxOutputBytes: number,
): AsyncGenerator<ProviderExecEvent> {
  const streams = [
    ["stdout", new TextEncoder().encode(result.stdout ?? "")],
    ["stderr", new TextEncoder().encode(result.stderr ?? "")],
  ] as const;
  let sequence = 0;
  let remaining = maxOutputBytes;
  let outputTruncated = false;
  for (const [type, bytes] of streams) {
    const data = bytes.slice(0, remaining);
    remaining -= data.byteLength;
    const truncated = data.byteLength < bytes.byteLength;
    outputTruncated ||= truncated;
    if (data.byteLength > 0) {
      yield {
        type,
        sequence: sequence++,
        data,
        ...(truncated ? { truncated: true } : {}),
      };
    }
  }
  yield {
    type: "exit",
    sequence,
    exitCode: result.statusCode ?? null,
    signal: result.statusCode == null ? "UNKNOWN" : null,
    cancelled: false,
    outputTruncated,
  };
}

function validateReadRange(offsetBytes: number, maxBytes: number): void {
  if (
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_FILE_BYTES
  ) {
    throw new ProviderError("Invalid Freestyle file read range", "invalid_request", false);
  }
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function normalizePath(path: string): string {
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

function fileEntry(path: string, stat: FileStat, kind: string): ProviderFileEntry {
  return {
    path,
    type: stat.isFile
      ? "file"
      : stat.isDirectory
        ? "directory"
        : stat.isSymlink || kind === "symlink"
          ? "symlink"
          : "other",
    sizeBytes: stat.isFile ? stat.size : null,
    modifiedAt: stat.modified ? new Date(stat.modified) : null,
  };
}

function usageFromVm(vm: VmData, destroyedAt?: string): FinalUsage {
  return {
    createdAt: vm.createdAt,
    ...(destroyedAt ? { destroyedAt } : {}),
    resources: vm.resources,
    snapshotId: vm.snapshotId,
    totalRunSeconds: vm.totalRunSeconds ?? 0,
  };
}

function finalUsageFromMetadata(
  metadata: Record<string, unknown> | undefined,
): FinalUsage | undefined {
  const value = asRecord(metadata?.freestyle);
  const resources = asRecord(value?.resources);
  if (
    typeof value?.createdAt !== "string" ||
    typeof value.totalRunSeconds !== "number" ||
    typeof resources?.cpu !== "number" ||
    typeof resources.memory !== "number" ||
    typeof resources.storage !== "number"
  ) {
    return undefined;
  }
  return {
    createdAt: value.createdAt,
    ...(typeof value.destroyedAt === "string" ? { destroyedAt: value.destroyedAt } : {}),
    resources: {
      cpu: resources.cpu,
      memory: resources.memory,
      storage: resources.storage,
    },
    ...(typeof value.snapshotId === "string" || value.snapshotId === null
      ? { snapshotId: value.snapshotId }
      : {}),
    totalRunSeconds: value.totalRunSeconds,
  };
}

function estimateCostMicrousd(
  totalRunSeconds: number,
  storageSeconds: number,
  resources: FinalUsage["resources"],
): bigint {
  for (const value of [
    totalRunSeconds,
    storageSeconds,
    resources.cpu,
    resources.memory,
    resources.storage,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProviderError("Freestyle usage contained a non-integer value", "unavailable", true);
    }
  }
  const runSeconds = BigInt(totalRunSeconds);
  const diskSeconds = BigInt(storageSeconds);
  const denominator = MIB_PER_GIB * SECONDS_PER_HOUR;
  const numerator =
    runSeconds *
      (BigInt(resources.cpu) * VCPU_MICROUSD_PER_HOUR * MIB_PER_GIB +
        BigInt(resources.memory) * MEMORY_GIB_MICROUSD_PER_HOUR) +
    diskSeconds * BigInt(resources.storage) * STORAGE_GIB_MICROUSD_PER_HOUR;
  return (numerator + denominator / 2n) / denominator;
}

function parseVmData(value: unknown): VmData {
  const record = asRecord(value);
  const resources = asRecord(record?.resources);
  const validState = ["starting", "running", "pausing", "paused", "stopped"].includes(
    String(record?.state),
  );
  if (
    typeof record?.id !== "string" ||
    !validState ||
    typeof resources?.cpu !== "number" ||
    typeof resources.memory !== "number" ||
    typeof resources.storage !== "number" ||
    typeof record.createdAt !== "string" ||
    !asRecord(record.metadata)
  ) {
    throw new Error("Freestyle VM response was invalid");
  }
  return record as unknown as VmData;
}

function parseListVms(value: unknown): ListVmsResult {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.vms)) {
    throw new Error("Freestyle VM list response was invalid");
  }
  return {
    ...(record as unknown as ListVmsResult),
    vms: record.vms.map(parseVmData),
  };
}

function parseExecResult(value: unknown): ExecResult {
  const record = asRecord(value);
  if (
    !record ||
    ![undefined, null, "string"].includes(typeofOrNull(record.stdout)) ||
    ![undefined, null, "string"].includes(typeofOrNull(record.stderr)) ||
    !(
      record.statusCode === undefined ||
      record.statusCode === null ||
      typeof record.statusCode === "number"
    )
  ) {
    throw new Error("Freestyle exec response was invalid");
  }
  return record as ExecResult;
}

function parseFileStat(value: unknown): FileStat {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.size !== "number" ||
    typeof record.isFile !== "boolean" ||
    typeof record.isDirectory !== "boolean" ||
    typeof record.isSymlink !== "boolean" ||
    typeof record.modified !== "string"
  ) {
    throw new Error("Freestyle file stat response was invalid");
  }
  return record as unknown as FileStat;
}

function parseDirEntries(value: unknown): Array<{ name: string; kind: string }> {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.entries)) {
    throw new Error("Freestyle directory response was invalid");
  }
  return record.entries.map((entry) => {
    const item = asRecord(entry);
    if (!item || typeof item.name !== "string" || typeof item.kind !== "string") {
      throw new Error("Freestyle directory entry was invalid");
    }
    return { name: item.name, kind: item.kind };
  });
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function typeofOrNull(value: unknown): string | null | undefined {
  return value === null ? null : value === undefined ? undefined : typeof value;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
