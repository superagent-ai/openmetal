import {
  ProviderError,
  resolveProviderResources,
  type ProviderCancelExecInput,
  type ProviderCancelExecResult,
  type ProviderCreateSandboxInput,
  type ProviderDeleteFileInput,
  type ProviderDeleteFileResult,
  type ProviderExecEvent,
  type ProviderExecInput,
  type ProviderExecResult,
  type ProviderExposeHttpEndpointInput,
  type ProviderFileCapabilities,
  type ProviderHttpEndpointLease,
  type ProviderListFilesInput,
  type ProviderListFilesResult,
  type ProviderReadFileInput,
  type ProviderReadFileResult,
  type ProviderRevokeHttpEndpointInput,
  type ProviderRevokeHttpEndpointResult,
  type ProviderSandbox,
  type ProviderSandboxCost,
  type ProviderSandboxCostInput,
  type ProviderWriteFileInput,
  type ProviderWriteFileResult,
  type SandboxProvider,
  type SandboxProviderName,
} from "@openmetal/provider-core";

export type FakeRuntimeOperation =
  | "exec"
  | "cancelExec"
  | "readFile"
  | "writeFile"
  | "listFiles"
  | "deleteFile"
  | "exposeHttpEndpoint"
  | "revokeHttpEndpoint";

export type FakeExecOutput = {
  type: "stdout" | "stderr";
  data: string | Uint8Array;
};

type FakeExecutionState = {
  providerResourceId: string;
  cancelled: boolean;
  finished: boolean;
};

export type FakeProviderBehavior = {
  failures?: Array<{
    kind: ConstructorParameters<typeof ProviderError>[1];
    retryable: boolean;
  }>;
  unknownCreatesResource?: boolean;
  unsupportedRuntimeOperations?: FakeRuntimeOperation[];
  runtimeLimits?: Partial<
    Pick<ProviderFileCapabilities, "maxReadBytes" | "maxWriteBytes" | "maxListEntries"> & {
      maxOutputBytes: number;
      maxLeaseDurationSeconds: number;
    }
  >;
  exec?: {
    output?: FakeExecOutput[];
    exitCode?: number;
    signal?: string;
    dropStreamAfterEvents?: number;
  };
  now?: Date;
};

export class FakeSandboxProvider implements SandboxProvider {
  readonly capabilities: SandboxProvider["capabilities"];
  readonly resources = new Map<string, ProviderSandbox & { paused: boolean }>();
  readonly files = new Map<string, Map<string, Uint8Array>>();
  readonly endpointLeases = new Map<
    string,
    ProviderHttpEndpointLease & {
      providerResourceId: string;
      revoked: boolean;
    }
  >();
  private failures: FakeProviderBehavior["failures"];
  private readonly executions = new Map<string, FakeExecutionState>();
  private executionSequence = 0;
  private endpointSequence = 0;
  costMicrousd: bigint | null = null;

  constructor(
    readonly name: SandboxProviderName = "e2b",
    private readonly behavior: FakeProviderBehavior = {},
  ) {
    this.failures = [...(behavior.failures ?? [])];
    const unsupported = new Set(behavior.unsupportedRuntimeOperations ?? []);
    this.capabilities = {
      pause: true,
      resume: true,
      cost: true,
      sizing: "direct",
      sources: ["environment", "oci_image", "provider_template"],
      runtime: {
        process: {
          exec: !unsupported.has("exec"),
          streams: !unsupported.has("exec"),
          cancel: !unsupported.has("cancelExec"),
          maxOutputBytes: behavior.runtimeLimits?.maxOutputBytes ?? 1_048_576,
        },
        files: {
          read: !unsupported.has("readFile"),
          write: !unsupported.has("writeFile"),
          writeModes: unsupported.has("writeFile") ? [] : ["create", "overwrite", "append"],
          createParents: !unsupported.has("writeFile"),
          list: !unsupported.has("listFiles"),
          delete: !unsupported.has("deleteFile"),
          maxReadBytes: behavior.runtimeLimits?.maxReadBytes ?? 1_048_576,
          maxWriteBytes: behavior.runtimeLimits?.maxWriteBytes ?? 1_048_576,
          maxListEntries: behavior.runtimeLimits?.maxListEntries ?? 1_000,
        },
        httpEndpoints: {
          expose: !unsupported.has("exposeHttpEndpoint"),
          revoke: !unsupported.has("revokeHttpEndpoint"),
          maxLeaseDurationSeconds: behavior.runtimeLimits?.maxLeaseDurationSeconds ?? 3_600,
        },
      },
    };
  }

  setCost(amountMicrousd: bigint) {
    this.costMicrousd = amountMicrousd;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const existing = this.resources.get(input.metalSandboxId);
    if (existing) return existing;
    const failure = this.failures?.shift();
    if (failure) {
      if (failure.kind === "unknown_outcome" && this.behavior.unknownCreatesResource) {
        this.resources.set(input.metalSandboxId, this.makeResource(input));
      }
      throw new ProviderError("injected provider failure", failure.kind, failure.retryable);
    }
    const resource = this.makeResource(input);
    this.resources.set(input.metalSandboxId, resource);
    return resource;
  }

  async reconcileCreate(metalSandboxId: string): Promise<ProviderSandbox | null> {
    return this.resources.get(metalSandboxId) ?? null;
  }

  async pause(providerResourceId: string): Promise<void> {
    const resource = this.find(providerResourceId);
    resource.paused = true;
  }

  async resume(providerResourceId: string): Promise<ProviderSandbox> {
    const resource = this.find(providerResourceId);
    resource.paused = false;
    return resource;
  }

  async destroy(providerResourceId: string): Promise<void> {
    for (const [key, resource] of this.resources) {
      if (resource.providerResourceId === providerResourceId) {
        this.resources.delete(key);
        this.files.delete(providerResourceId);
      }
    }
    for (const [executionId, execution] of this.executions) {
      if (execution.providerResourceId === providerResourceId) {
        this.executions.delete(executionId);
      }
    }
    for (const [leaseId, lease] of this.endpointLeases) {
      if (lease.providerResourceId === providerResourceId) {
        this.endpointLeases.delete(leaseId);
      }
    }
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost> {
    return {
      amountMicrousd:
        this.costMicrousd ?? BigInt(Math.max(0, input.to.getTime() - input.from.getTime())),
      providerOrganizationId: input.providerOrganizationId ?? "fake-account",
      measuredThrough: input.to,
      provenance: "provider_metered",
      confidence: "high",
      source: "fake-provider",
      raw: { fake: true },
    };
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    this.assertRuntimeOperation("exec", input);
    this.find(input.providerResourceId);
    const capabilities = this.capabilities.runtime?.process;
    if (!capabilities?.exec || !capabilities.streams) {
      throw this.unsupported("exec");
    }
    if (input.command.length === 0) {
      throw new ProviderError("command must not be empty", "invalid_request", false);
    }
    const maxOutputBytes = Math.min(
      input.maxOutputBytes ?? capabilities.maxOutputBytes,
      capabilities.maxOutputBytes,
    );
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) {
      throw new ProviderError(
        "maxOutputBytes must be a non-negative integer",
        "invalid_request",
        false,
      );
    }

    const executionId = `fake-exec-${++this.executionSequence}`;
    const execution = {
      providerResourceId: input.providerResourceId,
      cancelled: false,
      finished: false,
    };
    this.executions.set(executionId, execution);
    const configuredOutput = this.behavior.exec?.output ?? [
      { type: "stdout" as const, data: "fake stdout\n" },
      { type: "stderr" as const, data: "fake stderr\n" },
    ];
    const output = configuredOutput.map((event) => ({
      type: event.type,
      data: this.toBytes(event.data),
    }));
    const totalOutputBytes = output.reduce((total, event) => total + event.data.byteLength, 0);
    const outputTruncated = totalOutputBytes > maxOutputBytes;

    return {
      executionId,
      events: this.streamExecEvents(input, execution, output, maxOutputBytes, outputTruncated),
    };
  }

  async cancelExec(input: ProviderCancelExecInput): Promise<ProviderCancelExecResult> {
    this.assertRuntimeOperation("cancelExec", input);
    this.find(input.providerResourceId);
    if (!this.capabilities.runtime?.process?.cancel) {
      throw this.unsupported("cancelExec");
    }
    const execution = this.executions.get(input.executionId);
    const cancelled =
      execution?.providerResourceId === input.providerResourceId && !execution.finished;
    if (cancelled && execution) execution.cancelled = true;
    return { executionId: input.executionId, cancelled };
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    this.assertRuntimeOperation("readFile", input);
    this.find(input.providerResourceId);
    const capabilities = this.capabilities.runtime?.files;
    if (!capabilities?.read) throw this.unsupported("readFile");
    const file = this.files.get(input.providerResourceId)?.get(input.path);
    if (!file) throw new ProviderError("fake file not found", "invalid_request", false);
    const offsetBytes = input.offsetBytes ?? 0;
    const maxBytes = Math.min(
      input.maxBytes ?? capabilities.maxReadBytes,
      capabilities.maxReadBytes,
    );
    if (
      !Number.isInteger(offsetBytes) ||
      offsetBytes < 0 ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 0
    ) {
      throw new ProviderError("maxBytes must be a non-negative integer", "invalid_request", false);
    }
    const bytes = file.slice(offsetBytes, offsetBytes + maxBytes);
    const encoding = input.encoding ?? "binary";
    const eof = offsetBytes + bytes.byteLength >= file.byteLength;
    return {
      path: input.path,
      encoding,
      data: encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes,
      offsetBytes,
      byteLength: bytes.byteLength,
      sizeBytes: file.byteLength,
      eof,
      truncated: !eof,
    };
  }

  async writeFile(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult> {
    this.assertRuntimeOperation("writeFile", input);
    this.find(input.providerResourceId);
    const capabilities = this.capabilities.runtime?.files;
    if (!capabilities?.write) throw this.unsupported("writeFile");
    const incoming = this.toBytes(input.data);
    const files = this.files.get(input.providerResourceId) ?? new Map<string, Uint8Array>();
    const existing = files.get(input.path);
    const mode = input.mode ?? "overwrite";
    if (mode === "create" && existing) {
      throw new ProviderError("fake file already exists", "invalid_request", false);
    }
    const bytes =
      mode === "append" && existing ? Uint8Array.from([...existing, ...incoming]) : incoming;
    if (bytes.byteLength > capabilities.maxWriteBytes) {
      throw new ProviderError("fake file exceeds maxWriteBytes", "invalid_request", false);
    }
    const created = !existing;
    files.set(input.path, bytes.slice());
    this.files.set(input.providerResourceId, files);
    return { path: input.path, bytesWritten: incoming.byteLength, created };
  }

  async listFiles(input: ProviderListFilesInput): Promise<ProviderListFilesResult> {
    this.assertRuntimeOperation("listFiles", input);
    this.find(input.providerResourceId);
    const capabilities = this.capabilities.runtime?.files;
    if (!capabilities?.list) throw this.unsupported("listFiles");
    const maxEntries = Math.min(
      input.maxEntries ?? capabilities.maxListEntries,
      capabilities.maxListEntries,
    );
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new ProviderError(
        "maxEntries must be a non-negative integer",
        "invalid_request",
        false,
      );
    }
    const prefix = input.path.endsWith("/") ? input.path : `${input.path}/`;
    const entries = [...(this.files.get(input.providerResourceId) ?? new Map()).entries()]
      .filter(([path]) => path === input.path || path.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, data]) => ({
        path,
        type: "file" as const,
        sizeBytes: data.byteLength,
        modifiedAt: null,
      }));
    return {
      entries: entries.slice(0, maxEntries),
      truncated: entries.length > maxEntries,
    };
  }

  async deleteFile(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult> {
    this.assertRuntimeOperation("deleteFile", input);
    this.find(input.providerResourceId);
    if (!this.capabilities.runtime?.files?.delete) throw this.unsupported("deleteFile");
    return {
      path: input.path,
      deleted: this.files.get(input.providerResourceId)?.delete(input.path) ?? false,
    };
  }

  async exposeHttpEndpoint(
    input: ProviderExposeHttpEndpointInput,
  ): Promise<ProviderHttpEndpointLease> {
    this.assertRuntimeOperation("exposeHttpEndpoint", input);
    this.find(input.providerResourceId);
    const capabilities = this.capabilities.runtime?.httpEndpoints;
    if (!capabilities?.expose) throw this.unsupported("exposeHttpEndpoint");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
      throw new ProviderError("port must be between 1 and 65535", "invalid_request", false);
    }
    const maxLeaseDurationSeconds = capabilities.maxLeaseDurationSeconds;
    if (
      input.leaseDurationSeconds < 1 ||
      !Number.isInteger(input.leaseDurationSeconds) ||
      (maxLeaseDurationSeconds !== undefined &&
        input.leaseDurationSeconds > maxLeaseDurationSeconds)
    ) {
      throw new ProviderError("invalid endpoint lease duration", "invalid_request", false);
    }
    const leaseId = `fake-lease-${++this.endpointSequence}`;
    const duration = input.leaseDurationSeconds;
    const url = new URL(`https://${input.providerResourceId}.fake.invalid:${input.port}`);
    if (input.path) url.pathname = input.path.startsWith("/") ? input.path : `/${input.path}`;
    const lease = {
      leaseId,
      url: url.toString(),
      expiresAt: new Date(
        (this.behavior.now ?? new Date("2026-01-01T00:00:00.000Z")).getTime() + duration * 1_000,
      ),
      providerResourceId: input.providerResourceId,
      revoked: false,
    };
    this.endpointLeases.set(leaseId, lease);
    return { leaseId: lease.leaseId, url: lease.url, expiresAt: lease.expiresAt };
  }

  async revokeHttpEndpoint(
    input: ProviderRevokeHttpEndpointInput,
  ): Promise<ProviderRevokeHttpEndpointResult> {
    this.assertRuntimeOperation("revokeHttpEndpoint", input);
    this.find(input.providerResourceId);
    if (!this.capabilities.runtime?.httpEndpoints?.revoke) {
      throw this.unsupported("revokeHttpEndpoint");
    }
    const lease = this.endpointLeases.get(input.leaseId);
    const revoked =
      lease?.providerResourceId === input.providerResourceId && lease.revoked === false;
    if (revoked && lease) lease.revoked = true;
    return { leaseId: input.leaseId, revoked };
  }

  private makeResource(input: ProviderCreateSandboxInput) {
    return {
      providerResourceId: `fake-${input.metalSandboxId}`,
      providerOrganizationId: "fake-account",
      providerMetadata: { metalSandboxId: input.metalSandboxId },
      resolvedResources: resolveProviderResources(
        this.name,
        input.resources,
        input.providerOptions,
      ),
      paused: false,
    };
  }

  private assertRuntimeOperation(
    operation: FakeRuntimeOperation,
    input: { deadline?: Date; signal?: AbortSignal },
  ): void {
    if (input.signal?.aborted) {
      throw new ProviderError(`fake ${operation} aborted`, "customer", false);
    }
    if (input.deadline && input.deadline.getTime() <= Date.now()) {
      throw new ProviderError(`fake ${operation} deadline exceeded`, "timeout_absent", true);
    }
    if (this.behavior.unsupportedRuntimeOperations?.includes(operation)) {
      throw this.unsupported(operation);
    }
  }

  private async *streamExecEvents(
    input: ProviderExecInput,
    execution: FakeExecutionState,
    output: FakeExecOutput[],
    maxOutputBytes: number,
    outputTruncated: boolean,
  ): AsyncGenerator<ProviderExecEvent> {
    let sequence = 0;
    let emittedBytes = 0;
    for (const event of output) {
      this.assertRuntimeOperation("exec", input);
      if (execution.cancelled) {
        execution.finished = true;
        yield this.exitEvent(sequence, null, null, true, outputTruncated);
        return;
      }
      if (
        this.behavior.exec?.dropStreamAfterEvents !== undefined &&
        sequence >= this.behavior.exec.dropStreamAfterEvents
      ) {
        throw new ProviderError("fake exec stream dropped", "unknown_outcome", true);
      }
      const source = this.toBytes(event.data);
      const remaining = Math.max(0, maxOutputBytes - emittedBytes);
      const data = source.slice(0, remaining);
      const truncated = data.byteLength < source.byteLength;
      emittedBytes += data.byteLength;
      if (data.byteLength > 0 || source.byteLength === 0) {
        yield {
          type: event.type,
          sequence: sequence++,
          data,
          ...(truncated ? { truncated: true } : {}),
        };
      }
    }
    this.assertRuntimeOperation("exec", input);
    if (
      this.behavior.exec?.dropStreamAfterEvents !== undefined &&
      sequence >= this.behavior.exec.dropStreamAfterEvents
    ) {
      throw new ProviderError("fake exec stream dropped", "unknown_outcome", true);
    }
    execution.finished = true;
    yield this.exitEvent(
      sequence,
      execution.cancelled ? null : (this.behavior.exec?.exitCode ?? 0),
      execution.cancelled ? null : (this.behavior.exec?.signal ?? null),
      execution.cancelled,
      outputTruncated,
    );
  }

  private exitEvent(
    sequence: number,
    exitCode: number | null,
    signal: string | null,
    cancelled: boolean,
    outputTruncated: boolean,
  ): ProviderExecEvent {
    return { type: "exit", sequence, exitCode, signal, cancelled, outputTruncated };
  }

  private toBytes(data: string | Uint8Array): Uint8Array {
    return typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
  }

  private unsupported(operation: FakeRuntimeOperation): ProviderError {
    return new ProviderError(
      `fake runtime operation is unsupported: ${operation}`,
      "unsupported",
      false,
    );
  }

  private find(providerResourceId: string) {
    const resource = [...this.resources.values()].find(
      (candidate) => candidate.providerResourceId === providerResourceId,
    );
    if (!resource) throw new Error("fake resource not found");
    return resource;
  }
}
