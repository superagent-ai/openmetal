import { z } from "zod";
import { ProviderError, resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCancelExecInput,
  ProviderCancelExecResult,
  ProviderCreateSandboxInput,
  ProviderDeleteFileInput,
  ProviderDeleteFileResult,
  ProviderExecEvent,
  ProviderExecInput,
  ProviderExecResult,
  ProviderExposeHttpEndpointInput,
  ProviderHttpEndpointLease,
  ProviderListFilesInput,
  ProviderListFilesResult,
  ProviderReadFileInput,
  ProviderReadFileResult,
  ProviderRevokeHttpEndpointInput,
  ProviderRevokeHttpEndpointResult,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  ProviderWriteFileInput,
  ProviderWriteFileResult,
  SandboxProvider,
} from "@openmetal/provider-core";

const MAX_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const MAX_READ_BYTES = 10 * 1_024 * 1_024;
const MAX_WRITE_BYTES = 10 * 1_024 * 1_024;
const MULTIPART_CHUNK_BYTES = 5 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 10_000;
const MAX_LEASE_SECONDS = 86_400;

const SandboxSchema = z
  .object({
    metadata: z
      .object({
        name: z.string().min(1),
        externalId: z.string().optional(),
        workspace: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough(),
    spec: z.record(z.string(), z.unknown()),
    status: z.string().optional(),
    state: z.enum(["RUNNING", "STANDBY"]).optional(),
  })
  .passthrough();

const ProcessSchema = z
  .object({
    pid: z.string().min(1),
    status: z.enum(["failed", "killed", "stopped", "running", "completed"]),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional().default(""),
    stderr: z.string().optional().default(""),
  })
  .passthrough();

const DirectorySchema = z
  .object({
    files: z.array(
      z
        .object({
          path: z.string(),
          size: z.number().int().nonnegative(),
          lastModified: z.string().optional(),
        })
        .passthrough(),
    ),
    subdirectories: z.array(
      z
        .object({
          path: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const PreviewSchema = z
  .object({
    metadata: z.object({ name: z.string().min(1) }).passthrough(),
    spec: z.object({ url: z.string().url() }).passthrough(),
  })
  .passthrough();

export type BlaxelSandboxProviderOptions = {
  apiKey: string;
  workspace: string;
  accountId?: string;
  apiUrl?: string;
  apiVersion?: string;
  defaultImage?: string;
  defaultMemoryMb?: number;
  region?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class BlaxelRequestError extends Error {
  constructor(readonly status: number) {
    super(`Blaxel request failed (${status})`);
  }
}

export class BlaxelSandboxProvider implements SandboxProvider {
  readonly name = "blaxel" as const;
  readonly capabilities: SandboxProvider["capabilities"];
  private readonly apiKey: string;
  private readonly workspace: string;
  private accountId?: string;
  private readonly apiUrl: string;
  private readonly apiVersion: string;
  private readonly defaultImage: string;
  private readonly defaultMemoryMb: number;
  private readonly region?: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimeUrls = new Map<string, string>();
  private readonly cancelledExecutions = new Set<string>();
  private previewSequence = 0;

  constructor(options: BlaxelSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.workspace = options.workspace;
    this.accountId = options.accountId;
    this.apiUrl = (options.apiUrl ?? "https://api.blaxel.ai/v0").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2026-04-28";
    this.defaultImage = options.defaultImage ?? "blaxel/base-image:latest";
    this.defaultMemoryMb = options.defaultMemoryMb ?? 2_048;
    this.region = options.region;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 65_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilities = {
      pause: false,
      cost: true,
      sizing: "direct",
      sources: ["environment", "oci_image"],
      runtime: {
        process: {
          exec: true,
          streams: false,
          cancel: true,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
        files: {
          read: true,
          write: true,
          writeModes: ["create", "overwrite", "append"],
          createParents: true,
          list: true,
          delete: true,
          maxReadBytes: MAX_READ_BYTES,
          maxWriteBytes: MAX_WRITE_BYTES,
          maxListEntries: MAX_LIST_ENTRIES,
        },
        httpEndpoints: {
          expose: true,
          revoke: true,
          maxLeaseDurationSeconds: MAX_LEASE_SECONDS,
        },
      },
    };
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("blaxel", input.resources, input.providerOptions);
    const memoryMb = Math.max(
      this.defaultMemoryMb,
      input.resources.memoryMb,
      Math.ceil(input.resources.vcpu * 2_048),
    );
    const externalId = input.metalSandboxId.replace(/[^a-zA-Z0-9-]/g, "-");
    const name = `metal-${externalId}`;
    let created: z.infer<typeof SandboxSchema> | undefined;
    try {
      created = SandboxSchema.parse(
        await this.request("/sandboxes?createIfNotExist=true", {
          method: "POST",
          body: JSON.stringify({
            metadata: {
              name,
              externalId,
              labels: {
                "metal.organization_id": input.organizationId,
                "metal.project_id": input.projectId,
                "metal.sandbox_id": input.metalSandboxId,
              },
            },
            spec: {
              enabled: true,
              ...(this.region ? { region: this.region } : {}),
              runtime: {
                image: input.image ?? this.defaultImage,
                memory: memoryMb,
                ttl: `${input.ttlMinutes}m`,
              },
            },
          }),
          signal: input.signal,
        }),
      );
    } catch (error) {
      const recoverableCreateTimeout =
        (error instanceof BlaxelRequestError && error.status === 504) ||
        (error instanceof DOMException && error.name === "TimeoutError");
      if (!recoverableCreateTimeout) {
        throw error;
      }
    }
    const ready = await this.waitUntilReady(name, input.signal);
    if (ready.metadata.url) {
      this.runtimeUrls.set(name, ready.metadata.url.replace(/\/$/, ""));
    }
    return {
      providerResourceId: name,
      providerOrganizationId: this.accountId ?? ready.metadata.workspace ?? this.workspace,
      providerMetadata: {
        blaxel: ready,
        createdStatus: created?.status ?? "CREATE_TIMEOUT_RECOVERED",
      },
      resolvedResources: {
        ...resolved,
        vcpu: memoryMb / 2_048,
        memoryMb,
      },
    };
  }

  async pause(): Promise<void> {
    throw new Error("Blaxel sandboxes use automatic standby");
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
    this.runtimeUrls.delete(providerResourceId);
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    this.assertRuntimeInput("exec", input);
    if (input.command.length === 0) {
      throw new ProviderError("command must not be empty", "invalid_request", false);
    }
    if (input.stdin !== undefined) {
      throw new ProviderError(
        "Blaxel process execution does not accept stdin",
        "unsupported",
        false,
      );
    }
    const maxOutputBytes = this.limit(
      input.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    const runtimeUrl = await this.resolveRuntimeUrl(input.providerResourceId, input);
    const timeoutSeconds = input.deadline
      ? Math.max(1, Math.ceil((input.deadline.getTime() - Date.now()) / 1_000))
      : Math.max(1, Math.ceil(this.requestTimeoutMs / 1_000));
    const process = ProcessSchema.parse(
      await this.runtimeJson(runtimeUrl, "/process", {
        method: "POST",
        body: JSON.stringify({
          command: input.command.map(shellQuote).join(" "),
          ...(input.cwd ? { workingDir: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : {}),
          timeout: timeoutSeconds,
          waitForCompletion: false,
        }),
        signal: this.operationSignal(input),
      }),
    );
    return {
      executionId: process.pid,
      events: this.processEvents(runtimeUrl, process, input, maxOutputBytes),
    };
  }

  async cancelExec(input: ProviderCancelExecInput): Promise<ProviderCancelExecResult> {
    this.assertRuntimeInput("cancelExec", input);
    const runtimeUrl = await this.resolveRuntimeUrl(input.providerResourceId, input);
    const result = await this.runtimeJson(
      runtimeUrl,
      `/process/${encodeURIComponent(input.executionId)}/kill`,
      {
        method: "DELETE",
        signal: this.operationSignal(input),
        allowNotFound: true,
      },
    );
    if (result !== null) {
      this.cancelledExecutions.add(executionKey(input.providerResourceId, input.executionId));
    }
    return { executionId: input.executionId, cancelled: result !== null };
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    this.assertRuntimeInput("readFile", input);
    const offsetBytes = this.limit(input.offsetBytes ?? 0, Number.MAX_SAFE_INTEGER, "offsetBytes");
    const maxBytes = this.limit(input.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES, "maxBytes");
    const runtimeUrl = await this.resolveRuntimeUrl(input.providerResourceId, input);
    const response = await this.runtimeResponse(
      runtimeUrl,
      `/filesystem/${runtimePath(input.path)}?download=true`,
      {
        method: "GET",
        signal: this.operationSignal(input),
        headers: {
          accept: "application/octet-stream",
          range: `bytes=${offsetBytes}-${offsetBytes + maxBytes - 1}`,
        },
      },
    );
    if (!response) {
      throw new ProviderError("Blaxel file was not found", "invalid_request", false);
    }
    const payload = await readResponseBytes(
      response,
      response.status === 206 ? maxBytes : MAX_READ_BYTES,
    );
    const contentRange = parseContentRange(response.headers.get("content-range"));
    const sizeBytes = contentRange?.sizeBytes ?? payload.byteLength;
    const bytes =
      response.status === 206
        ? payload.slice(0, maxBytes)
        : payload.slice(offsetBytes, offsetBytes + maxBytes);
    const encoding = input.encoding ?? "binary";
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
    let bytes = toBytes(input.data);
    const runtimeUrl = await this.resolveRuntimeUrl(input.providerResourceId, input);
    const existing = await this.readExistingFile(runtimeUrl, input.path, input);
    const mode = input.mode ?? "overwrite";
    if (mode === "create" && existing) {
      throw new ProviderError("file already exists", "invalid_request", false);
    }
    if (mode === "append" && existing) {
      bytes = concatBytes(existing, bytes);
    }
    if (bytes.byteLength > MAX_WRITE_BYTES) {
      throw new ProviderError(
        `file exceeds the adapter's ${MAX_WRITE_BYTES}-byte write limit`,
        "invalid_request",
        false,
      );
    }
    if (input.createParents) {
      await this.createParentDirectories(runtimeUrl, input.path, input);
    }
    const initiated = z.object({ uploadId: z.string().min(1) }).parse(
      await this.runtimeJson(
        runtimeUrl,
        `/filesystem-multipart/initiate/${runtimePath(input.path)}`,
        {
          method: "POST",
          body: JSON.stringify({}),
          signal: this.operationSignal(input),
        },
      ),
    );
    try {
      const chunks =
        bytes.byteLength === 0
          ? [new Uint8Array()]
          : Array.from(
              { length: Math.ceil(bytes.byteLength / MULTIPART_CHUNK_BYTES) },
              (_, index) =>
                bytes.slice(index * MULTIPART_CHUNK_BYTES, (index + 1) * MULTIPART_CHUNK_BYTES),
            );
      const uploadedParts: Array<{ etag: string; partNumber: number }> = [];
      for (const [index, chunk] of chunks.entries()) {
        const partNumber = index + 1;
        const form = new FormData();
        const copy = new Uint8Array(chunk);
        form.set("file", new Blob([copy.buffer]), `part-${partNumber}`);
        const uploaded = z
          .object({ etag: z.string().min(1), partNumber: z.number().int().positive() })
          .parse(
            await this.runtimeJson(
              runtimeUrl,
              `/filesystem-multipart/${encodeURIComponent(
                initiated.uploadId,
              )}/part?partNumber=${partNumber}`,
              {
                method: "PUT",
                body: form,
                signal: this.operationSignal(input),
              },
            ),
          );
        uploadedParts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
      }
      await this.runtimeJson(
        runtimeUrl,
        `/filesystem-multipart/${encodeURIComponent(initiated.uploadId)}/complete`,
        {
          method: "POST",
          body: JSON.stringify({
            parts: uploadedParts,
          }),
          signal: this.operationSignal(input),
        },
      );
    } catch (error) {
      await this.runtimeJson(
        runtimeUrl,
        `/filesystem-multipart/${encodeURIComponent(initiated.uploadId)}/abort`,
        {
          method: "DELETE",
          signal: this.operationSignal(input),
          allowNotFound: true,
        },
      ).catch(() => undefined);
      throw error;
    }
    return {
      path: input.path,
      bytesWritten: toBytes(input.data).byteLength,
      created: existing === null,
    };
  }

  async listFiles(input: ProviderListFilesInput): Promise<ProviderListFilesResult> {
    this.assertRuntimeInput("listFiles", input);
    const maxEntries = this.limit(
      input.maxEntries ?? MAX_LIST_ENTRIES,
      MAX_LIST_ENTRIES,
      "maxEntries",
    );
    const runtimeUrl = await this.resolveRuntimeUrl(input.providerResourceId, input);
    const pending = [input.path];
    const entries: ProviderListFilesResult["entries"] = [];
    let overflow = false;
    while (pending.length > 0 && entries.length <= maxEntries) {
      const path = pending.shift()!;
      const directory = DirectorySchema.parse(
        await this.runtimeJson(runtimeUrl, `/filesystem/${runtimePath(path)}`, {
          method: "GET",
          signal: this.operationSignal(input),
        }),
      );
      for (const file of directory.files) {
        entries.push({
          path: normalizeRemotePath(file.path),
          type: "file",
          sizeBytes: file.size,
          modifiedAt: parseDate(file.lastModified),
        });
      }
      for (const subdirectory of directory.subdirectories) {
        const subdirectoryPath = normalizeRemotePath(subdirectory.path);
        entries.push({
          path: subdirectoryPath,
          type: "directory",
          sizeBytes: null,
          modifiedAt: null,
        });
        if (input.recursive) pending.push(subdirectoryPath);
      }
      if (entries.length > maxEntries) overflow = true;
    }
    return {
      entries: entries.slice(0, maxEntries),
      truncated: overflow || pending.length > 0,
    };
  }

  async deleteFile(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult> {
    this.assertRuntimeInput("deleteFile", input);
    const runtimeUrl = await this.resolveRuntimeUrl(input.providerResourceId, input);
    const query = input.recursive ? "?recursive=true" : "";
    const result = await this.runtimeJson(
      runtimeUrl,
      `/filesystem/${runtimePath(input.path)}${query}`,
      {
        method: "DELETE",
        signal: this.operationSignal(input),
        allowNotFound: true,
      },
    );
    return { path: input.path, deleted: result !== null };
  }

  async exposeHttpEndpoint(
    input: ProviderExposeHttpEndpointInput,
  ): Promise<ProviderHttpEndpointLease> {
    this.assertRuntimeInput("exposeHttpEndpoint", input);
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
      throw new ProviderError("port must be between 1 and 65535", "invalid_request", false);
    }
    const leaseDurationSeconds = this.limit(
      input.leaseDurationSeconds,
      MAX_LEASE_SECONDS,
      "leaseDurationSeconds",
    );
    const leaseId = `metal-${input.port}-${++this.previewSequence}`;
    const preview = PreviewSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(input.providerResourceId)}/previews`, {
        method: "POST",
        body: JSON.stringify({
          metadata: { name: leaseId },
          spec: {
            port: input.port,
            public: true,
            ttl: `${leaseDurationSeconds}s`,
          },
        }),
        signal: this.operationSignal(input),
      }),
    );
    const url = new URL(preview.spec.url);
    if (input.path) url.pathname = input.path.startsWith("/") ? input.path : `/${input.path}`;
    return {
      leaseId: preview.metadata.name,
      url: url.toString(),
      expiresAt: new Date(Date.now() + leaseDurationSeconds * 1_000),
    };
  }

  async revokeHttpEndpoint(
    input: ProviderRevokeHttpEndpointInput,
  ): Promise<ProviderRevokeHttpEndpointResult> {
    this.assertRuntimeInput("revokeHttpEndpoint", input);
    const result = await this.request(
      `/sandboxes/${encodeURIComponent(input.providerResourceId)}/previews/${encodeURIComponent(
        input.leaseId,
      )}`,
      {
        method: "DELETE",
        signal: this.operationSignal(input),
        allowNotFound: true,
      },
    );
    return { leaseId: input.leaseId, revoked: result !== null };
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const accountId = await this.resolveAccountId(input.signal);
    const query = new URLSearchParams({
      startTime: input.from.toISOString(),
      endTime: new Date(Math.max(input.to.getTime(), Date.now())).toISOString(),
      resolution: "hourly",
      resourceType: "sandbox",
      resourceName: input.providerResourceId,
    });
    const metrics = z
      .object({
        summary: z.object({ totalCost: z.number().nonnegative() }),
        data: z.array(z.record(z.string(), z.unknown())),
      })
      .passthrough()
      .parse(
        await this.request(`/accounts/${encodeURIComponent(accountId)}/metrics?${query}`, {
          method: "GET",
          signal: input.signal,
        }),
      );
    if (metrics.data.length === 0) {
      return null;
    }
    return {
      amountMicrousd: BigInt(Math.round(metrics.summary.totalCost * 1_000_000)),
      providerOrganizationId: accountId,
      measuredThrough: input.to,
      provenance: "provider_reported",
      confidence: "high",
      source: "blaxel-billing-explorer",
      raw: {
        source: "blaxel-billing-explorer",
        metrics,
      },
    };
  }

  private async resolveAccountId(signal?: AbortSignal): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const workspace = z
      .object({ accountId: z.string().min(1) })
      .passthrough()
      .parse(
        await this.request(`/workspaces/${encodeURIComponent(this.workspace)}`, {
          method: "GET",
          signal,
        }),
      );
    this.accountId = workspace.accountId;
    return workspace.accountId;
  }

  private async waitUntilReady(
    name: string,
    callerSignal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxSchema>> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const sandbox = SandboxSchema.parse(
        await this.request(`/sandboxes/${encodeURIComponent(name)}`, {
          method: "GET",
          signal: callerSignal,
        }),
      );
      if (sandbox.status === "DEPLOYED") {
        return sandbox;
      }
      if (sandbox.status === "FAILED" || sandbox.status === "TERMINATED") {
        throw new Error(`Blaxel sandbox entered ${sandbox.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error("Blaxel sandbox did not become ready");
  }

  private async *processEvents(
    runtimeUrl: string,
    initial: z.infer<typeof ProcessSchema>,
    input: ProviderExecInput,
    maxOutputBytes: number,
  ): AsyncGenerator<ProviderExecEvent> {
    let process = initial;
    while (process.status === "running") {
      await abortableDelay(250, this.operationSignal(input));
      process = ProcessSchema.parse(
        await this.runtimeJson(runtimeUrl, `/process/${encodeURIComponent(process.pid)}`, {
          method: "GET",
          signal: this.operationSignal(input),
        }),
      );
    }
    const output = [
      { type: "stdout" as const, data: toBytes(process.stdout) },
      { type: "stderr" as const, data: toBytes(process.stderr) },
    ];
    let sequence = 0;
    let emittedBytes = 0;
    let outputTruncated = false;
    for (const event of output) {
      const remaining = Math.max(0, maxOutputBytes - emittedBytes);
      const data = event.data.slice(0, remaining);
      const truncated = data.byteLength < event.data.byteLength;
      outputTruncated ||= truncated;
      emittedBytes += data.byteLength;
      if (data.byteLength > 0) {
        yield {
          type: event.type,
          sequence: sequence++,
          data,
          ...(truncated ? { truncated: true } : {}),
        };
      }
    }
    const cancelled =
      process.status === "killed" ||
      process.status === "stopped" ||
      this.cancelledExecutions.has(executionKey(input.providerResourceId, process.pid));
    this.cancelledExecutions.delete(executionKey(input.providerResourceId, process.pid));
    yield {
      type: "exit",
      sequence,
      exitCode: cancelled ? null : (process.exitCode ?? (process.status === "completed" ? 0 : 1)),
      signal: cancelled ? "SIGKILL" : null,
      cancelled,
      outputTruncated,
    };
  }

  private async resolveRuntimeUrl(
    providerResourceId: string,
    operation: { deadline?: Date; signal?: AbortSignal },
  ): Promise<string> {
    const cached = this.runtimeUrls.get(providerResourceId);
    if (cached) return cached;
    const sandbox = SandboxSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}`, {
        method: "GET",
        signal: this.operationSignal(operation),
      }),
    );
    if (!sandbox.metadata.url) {
      throw new ProviderError("Blaxel sandbox has no runtime URL", "unavailable", true);
    }
    const runtimeUrl = sandbox.metadata.url.replace(/\/$/, "");
    this.runtimeUrls.set(providerResourceId, runtimeUrl);
    return runtimeUrl;
  }

  private async readExistingFile(
    runtimeUrl: string,
    path: string,
    operation: { deadline?: Date; signal?: AbortSignal },
  ): Promise<Uint8Array | null> {
    const response = await this.runtimeResponse(
      runtimeUrl,
      `/filesystem/${runtimePath(path)}?download=true`,
      {
        method: "GET",
        signal: this.operationSignal(operation),
        headers: { accept: "application/octet-stream" },
        allowNotFound: true,
      },
    );
    return response ? await readResponseBytes(response, MAX_WRITE_BYTES) : null;
  }

  private async createParentDirectories(
    runtimeUrl: string,
    path: string,
    operation: { deadline?: Date; signal?: AbortSignal },
  ): Promise<void> {
    const segments = path.split("/").filter(Boolean).slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const parent = `/${segments.slice(0, index).join("/")}`;
      await this.runtimeJson(runtimeUrl, `/filesystem/${runtimePath(parent)}`, {
        method: "PUT",
        body: JSON.stringify({ isDirectory: true }),
        signal: this.operationSignal(operation),
      });
    }
  }

  private assertRuntimeInput(
    operation: string,
    input: { deadline?: Date; signal?: AbortSignal },
  ): void {
    if (input.signal?.aborted) {
      throw new ProviderError(`Blaxel ${operation} aborted`, "customer", false);
    }
    if (input.deadline && input.deadline.getTime() <= Date.now()) {
      throw new ProviderError(`Blaxel ${operation} deadline exceeded`, "timeout_absent", true);
    }
  }

  private operationSignal(input: { deadline?: Date; signal?: AbortSignal }): AbortSignal {
    this.assertRuntimeInput("runtime operation", input);
    const remaining = input.deadline
      ? input.deadline.getTime() - Date.now()
      : this.requestTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, Math.min(this.requestTimeoutMs, remaining)),
    );
    return input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
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

  private async runtimeJson(
    runtimeUrl: string,
    path: string,
    options: RuntimeRequestOptions,
  ): Promise<unknown | null> {
    const response = await this.runtimeResponse(runtimeUrl, path, options);
    if (!response) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async runtimeResponse(
    runtimeUrl: string,
    path: string,
    options: RuntimeRequestOptions,
  ): Promise<Response | null> {
    const response = await this.fetchImpl(`${runtimeUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "x-blaxel-workspace": this.workspace,
        ...(options.body && typeof options.body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...options.headers,
      },
      body: options.body,
      signal: options.signal,
    });
    if (options.allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new BlaxelRequestError(response.status);
    return response;
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
    },
  ): Promise<unknown | null> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "x-blaxel-workspace": this.workspace,
        "blaxel-version": this.apiVersion,
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
      throw new BlaxelRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}

type RuntimeRequestOptions = {
  method: "DELETE" | "GET" | "POST" | "PUT";
  body?: RequestInit["body"];
  signal: AbortSignal;
  headers?: Record<string, string>;
  allowNotFound?: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runtimePath(path: string): string {
  if (!path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new ProviderError(
      "path must be absolute without traversal segments",
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

function normalizeRemotePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseContentRange(value: string | null): { sizeBytes: number } | null {
  const match = value ? /^bytes \d+-\d+\/(\d+)$/.exec(value) : null;
  if (!match) return null;
  const sizeBytes = Number(match[1]);
  return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? { sizeBytes } : null;
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

function executionKey(providerResourceId: string, executionId: string): string {
  return `${providerResourceId}:${executionId}`;
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderError("Blaxel file response exceeds the read limit", "unsupported", false);
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
        "Blaxel file response exceeded the streaming read limit",
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

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
