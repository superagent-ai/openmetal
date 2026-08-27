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
    cost: false,
    sizing: "fixed",
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

  async destroy(providerResourceId: string): Promise<void> {
    try {
      const sandbox = await this.client.sandboxes.fromId(providerResourceId);
      await sandbox.terminate();
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
  }

  async pause(): Promise<void> {
    throw new Error("Modal sandboxes do not support pause");
  }

  async getCost(_input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    return null;
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
