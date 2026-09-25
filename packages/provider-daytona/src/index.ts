import { z } from "zod";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderComputerActionInput,
  ProviderComputerRecording,
  ProviderComputerScreenshot,
  ProviderComputerScreenshotInput,
  ProviderCancelExecInput,
  ProviderCancelExecResult,
  ProviderDeleteFileInput,
  ProviderDeleteFileResult,
  ProviderExecEvent,
  ProviderExecInput,
  ProviderExecResult,
  ProviderFailureKind,
  ProviderFileEntry,
  ProviderListFilesInput,
  ProviderListFilesResult,
  ProviderReadFileInput,
  ProviderReadFileResult,
  ProviderReconcileRecordingInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  ProviderSandboxInspection,
  ProviderSandboxState,
  ProviderStartRecordingInput,
  ProviderStopRecordingInput,
  ProviderWriteFileInput,
  ProviderWriteFileResult,
  SandboxProvider,
} from "@openmetal/provider-core";
import { ProviderError } from "@openmetal/provider-core";

const MAX_OUTPUT_BYTES = 100 * 1_024 * 1_024;
const MAX_FILE_BYTES = 10 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 10_000;
const IMAGE_READY_TIMEOUT_MS = 15 * 60_000;
const IMAGE_POLL_INTERVAL_MS = 2_000;
const PROCESS_POLL_INTERVAL_MS = 250;
const DAYTONA_EXECUTION_ID_PREFIX = "daytona:";
const DAYTONA_IMAGE_DISK_GB = 16;
const DAYTONA_TTL_GRACE_MINUTES = 15;
const MAX_ERROR_BODY_BYTES = 8 * 1_024;
const MAX_ERROR_DETAIL_CHARS = 300;
const DAYTONA_SANDBOX_UNAVAILABLE_CODES = new Set(["SANDBOX_NOT_FOUND", "SANDBOX_NOT_RUNNING"]);
const LOST_SANDBOX_STATES = new Set<ProviderSandboxState>(["stopped", "failed", "absent"]);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
// Deleting a Daytona session kills the session's process group, including processes a
// command left running in the background. setsid gives each command its own group; a running
// command is still a descendant of the session, so deleting the session still cancels it.
// setsid without -w (BusyBox) forks and loses the exit code only for a process group leader,
// which a command cannot be unless the session shell has job control enabled.
const DAYTONA_LAUNCHER = "metal_exec";
const DAYTONA_LAUNCHER_FUNCTION = `${DAYTONA_LAUNCHER}() { if setsid -w true 2>/dev/null; then setsid -w "$@"; elif [ "\${-#*m}" = "$-" ] && command -v setsid >/dev/null 2>&1; then setsid "$@"; else "$@"; fi; };`;
const DAYTONA_PENDING_STATES = new Set([
  "creating",
  "pending_build",
  "building_snapshot",
  "pulling_snapshot",
  "starting",
  "unknown",
  "restoring",
]);
const DAYTONA_FAILED_STATES = new Set(["error", "build_failed", "destroyed", "destroying"]);
const OCI_IMAGE_REFERENCE =
  /^(?:(?:localhost|[\w.-]+(?::\d+)?)\/)?[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128}))?$/;

const DaytonaSandboxSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    toolboxProxyUrl: z.string().url().optional(),
    state: z.string().min(1).optional(),
    errorReason: z.string().nullish(),
  })
  .passthrough();

const DaytonaFileInfoSchema = z
  .object({
    name: z.string(),
    size: z.number().nonnegative(),
    isDir: z.boolean(),
    modTime: z.string().optional(),
    modifiedAt: z.string().optional(),
    mode: z.string().optional(),
  })
  .passthrough();

const DaytonaScreenshotSchema = z
  .object({
    screenshot: z.string(),
    sizeBytes: z.number().int().nonnegative().optional(),
    cursorPosition: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .passthrough();

const DaytonaRecordingSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    label: z.string().optional(),
    fileName: z.string().optional(),
    filePath: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .passthrough();

const DaytonaRecordingsSchema = z
  .object({
    recordings: z.array(DaytonaRecordingSchema),
  })
  .passthrough();

const DaytonaSessionExecuteSchema = z
  .object({
    cmdId: z.string().min(1),
  })
  .passthrough();

const DaytonaCommandSchema = z
  .object({
    id: z.string().min(1),
    command: z.string(),
    exitCode: z.number().int().nullish(),
  })
  .passthrough();

const DaytonaCommandLogsSchema = z
  .object({
    output: z.string().nullish(),
    stdout: z.string().nullish(),
    stderr: z.string().nullish(),
  })
  .passthrough();

const DaytonaErrorBodySchema = z
  .object({
    code: z.string().optional(),
    message: z.union([z.string(), z.array(z.string())]).optional(),
    source: z.string().optional(),
  })
  .passthrough();

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function operationSignal(
  callerSignal: AbortSignal | undefined,
  deadline: Date | undefined,
): AbortSignal {
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  if (deadline) signals.push(AbortSignal.timeout(Math.max(0, deadline.getTime() - Date.now())));
  return signals.length === 0
    ? new AbortController().signal
    : signals.length === 1
      ? signals[0]!
      : AbortSignal.any(signals);
}

function deadlineSignal(
  callerSignal: AbortSignal | undefined,
  deadline: Date | undefined,
  requestTimeoutMs: number,
): AbortSignal {
  const signals = [AbortSignal.timeout(requestTimeoutMs)];
  if (callerSignal) signals.push(callerSignal);
  if (deadline) signals.push(AbortSignal.timeout(Math.max(0, deadline.getTime() - Date.now())));
  return AbortSignal.any(signals);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
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

export type DaytonaProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  analyticsApiUrl?: string;
  organizationId?: string;
  target?: string;
  pauseSupported?: boolean;
  requestTimeoutMs?: number;
  imageReadyTimeoutMs?: number;
  processPollIntervalMs?: number;
  fetchImpl?: typeof fetch;
};

type DaytonaSurface = "API" | "analytics" | "toolbox";

type DaytonaErrorDetails = {
  code?: string;
  detail?: string;
  fromDaemon?: boolean;
  sandboxUnavailable?: boolean;
};

class DaytonaRequestError extends ProviderError {
  readonly code?: string;
  readonly detail?: string;
  readonly fromDaemon: boolean;
  readonly sandboxUnavailable: boolean;

  constructor(
    readonly status: number,
    readonly surface: DaytonaSurface,
    details: DaytonaErrorDetails = {},
  ) {
    const sandboxUnavailable =
      details.sandboxUnavailable ??
      (details.code !== undefined && DAYTONA_SANDBOX_UNAVAILABLE_CODES.has(details.code));
    super(
      `Daytona ${surface} request failed (${status}${details.code ? ` ${details.code}` : ""})${details.detail ? `: ${details.detail}` : ""}`,
      sandboxUnavailable ? "unavailable" : daytonaFailureKind(status),
      status === 429 || status >= 500,
    );
    this.code = details.code;
    this.detail = details.detail;
    this.fromDaemon = details.fromDaemon ?? false;
    this.sandboxUnavailable = sandboxUnavailable;
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  readonly capabilities: SandboxProvider["capabilities"];
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly analyticsApiUrl: string;
  private readonly target?: string;
  private readonly requestTimeoutMs: number;
  private readonly imageReadyTimeoutMs: number;
  private readonly processPollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private organizationId?: string;
  private readonly toolboxUrls = new Map<string, string>();

  constructor(options: DaytonaProviderOptions) {
    this.capabilities = {
      pause: options.pauseSupported ?? false,
      cost: true,
      sizing: "template",
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
          writeModes: ["create", "overwrite"],
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
        computer: {
          implementation: "native",
          actions: [
            "mouse_move",
            "mouse_click",
            "mouse_drag",
            "mouse_scroll",
            "keyboard_type",
            "keyboard_key",
            "keyboard_hotkey",
          ],
          screenshot: {
            formats: ["png", "jpeg"],
            maxBytes: MAX_FILE_BYTES,
          },
          recording: {
            formats: ["mp4"],
          },
        },
      },
    };
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://app.daytona.io/api").replace(/\/$/, "");
    this.analyticsApiUrl = (options.analyticsApiUrl ?? "https://analytics.app.daytona.io").replace(
      /\/$/,
      "",
    );
    this.target = options.target;
    this.organizationId = options.organizationId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.imageReadyTimeoutMs = options.imageReadyTimeoutMs ?? IMAGE_READY_TIMEOUT_MS;
    this.processPollIntervalMs = options.processPollIntervalMs ?? PROCESS_POLL_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("daytona", input.resources, input.providerOptions);
    const image = daytonaImageSpec(input);
    const name = `metal-${input.metalSandboxId}`;
    let response: unknown;
    try {
      response = await this.request("/sandbox", {
        method: "POST",
        body: JSON.stringify({
          name,
          ephemeral: true,
          autoDeleteInterval: 0,
          // Daytona's default idle auto-stop ignores detached processes, and stopping an
          // ephemeral sandbox deletes it. Metal enforces the runtime timeout, so the TTL is
          // only a backstop; Daytona counts it from creation, before an image build finishes.
          autoStopInterval: 0,
          ttlMinutes:
            input.ttlMinutes +
            Math.ceil(this.imageReadyTimeoutMs / 60_000) +
            DAYTONA_TTL_GRACE_MINUTES,
          ...(image
            ? {
                // CreateSandbox has no image field. The Daytona SDK sends a registry
                // reference as a declarative build, which pulls that image.
                buildInfo: { dockerfileContent: `FROM ${input.image}\n` },
                cpu: image.cpu,
                memory: image.memoryGb,
                disk: image.diskGb,
              }
            : {}),
          ...(this.target ? { target: this.target } : {}),
          labels: {
            "metal.sandbox_id": input.metalSandboxId,
            "metal.organization_id": input.organizationId,
            "metal.project_id": input.projectId,
          },
        }),
        signal: input.signal,
        idempotencyKey: `metal-sandbox-${input.metalSandboxId}`,
      });
    } catch (error) {
      if (!(error instanceof DaytonaRequestError) || error.status !== 409) {
        throw error;
      }
      response = await this.request(`/sandbox/${encodeURIComponent(name)}`, {
        method: "GET",
        signal: input.signal,
      });
    }
    let parsed = DaytonaSandboxSchema.parse(response);
    if (image) parsed = await this.waitUntilStarted(parsed, input.signal);
    this.rememberSandbox(parsed);
    return {
      providerResourceId: parsed.id,
      providerOrganizationId: parsed.organizationId,
      resolvedResources: image
        ? {
            ...resolved,
            vcpu: image.cpu,
            memoryMb: image.memoryGb * 1024,
            diskMb: image.diskGb * 1024,
          }
        : resolved,
    };
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    try {
      let sandbox = DaytonaSandboxSchema.parse(
        await this.request(`/sandbox/${encodeURIComponent(`metal-${metalSandboxId}`)}`, {
          method: "GET",
          signal,
        }),
      );
      if (sandbox.state && sandbox.state !== "started") {
        sandbox = await this.waitUntilStarted(sandbox, signal);
      }
      this.rememberSandbox(sandbox);
      return {
        providerResourceId: sandbox.id,
        providerOrganizationId: sandbox.organizationId,
      };
    } catch (error) {
      if (error instanceof DaytonaRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async exec(input: ProviderExecInput): Promise<ProviderExecResult> {
    if (input.command.length === 0) {
      throw new ProviderError("Daytona command must not be empty", "invalid_request", false);
    }
    if (input.stdin !== undefined) {
      throw new ProviderError(
        "Daytona process execution does not support portable stdin",
        "unsupported",
        false,
      );
    }
    const maxOutputBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new ProviderError("Invalid Daytona output limit", "invalid_request", false);
    }
    const signal = operationSignal(input.signal, input.deadline);
    const sessionId = `metal-${crypto.randomUUID()}`;
    await this.toolboxJson(input.providerResourceId, "/process/session", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
      signal: deadlineSignal(signal, undefined, this.requestTimeoutMs),
    });
    let parsed: z.infer<typeof DaytonaSessionExecuteSchema>;
    try {
      parsed = DaytonaSessionExecuteSchema.parse(
        await this.toolboxJson(
          input.providerResourceId,
          `/process/session/${encodeURIComponent(sessionId)}/exec`,
          {
            method: "POST",
            body: JSON.stringify({
              command: daytonaSessionCommand(input),
              runAsync: true,
            }),
            signal: deadlineSignal(signal, undefined, this.requestTimeoutMs),
          },
        ),
      );
    } catch (error) {
      await this.deleteProcessSession(input.providerResourceId, sessionId).catch(() => undefined);
      throw error;
    }
    const executionId = encodeExecutionId(sessionId, parsed.cmdId);
    return {
      executionId,
      events: this.processEvents(
        input.providerResourceId,
        sessionId,
        parsed.cmdId,
        maxOutputBytes,
        signal,
      ),
    };
  }

  async cancelExec(input: ProviderCancelExecInput): Promise<ProviderCancelExecResult> {
    const { sessionId } = decodeExecutionId(input.executionId);
    await this.deleteProcessSession(
      input.providerResourceId,
      sessionId,
      operationSignal(input.signal, input.deadline),
    );
    return { executionId: input.executionId, cancelled: true };
  }

  private async *processEvents(
    providerResourceId: string,
    sessionId: string,
    commandId: string,
    maxOutputBytes: number,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderExecEvent> {
    let sessionDeleted = false;
    try {
      let exitCode: number | undefined;
      while (exitCode === undefined) {
        const command = DaytonaCommandSchema.parse(
          await this.toolboxJson(
            providerResourceId,
            `/process/session/${encodeURIComponent(sessionId)}/command/${encodeURIComponent(commandId)}`,
            {
              method: "GET",
              signal: deadlineSignal(signal, undefined, this.requestTimeoutMs),
            },
          ),
        );
        if (command.id !== commandId) {
          throw new ProviderError(
            "Daytona returned a different command identity",
            "unknown_outcome",
            false,
          );
        }
        exitCode = command.exitCode ?? undefined;
        if (exitCode === undefined) {
          await abortableDelay(this.processPollIntervalMs, signal);
        }
      }

      const logs = await this.toolboxCommandLogs(
        providerResourceId,
        `/process/session/${encodeURIComponent(sessionId)}/command/${encodeURIComponent(commandId)}/logs`,
        {
          method: "GET",
          signal: deadlineSignal(signal, undefined, this.requestTimeoutMs),
        },
      );
      const separated =
        logs.stdout !== null && logs.stdout !== undefined
          ? { stdout: logs.stdout, stderr: logs.stderr ?? "" }
          : splitDaytonaOutput(logs.output ?? "");

      await this.deleteProcessSession(providerResourceId, sessionId);
      sessionDeleted = true;

      const stdout = new TextEncoder().encode(separated.stdout);
      const stderr = new TextEncoder().encode(separated.stderr);
      let sequence = 0;
      let remaining = maxOutputBytes;
      let truncated = false;
      for (const [type, bytes] of [
        ["stdout", stdout],
        ["stderr", stderr],
      ] as const) {
        const data = bytes.slice(0, remaining);
        remaining -= data.length;
        if (data.length < bytes.length) truncated = true;
        if (data.length > 0) {
          yield {
            type,
            sequence: sequence++,
            data,
            ...(data.length < bytes.length ? { truncated: true } : {}),
          };
        }
      }
      yield {
        type: "exit",
        sequence,
        exitCode,
        signal: null,
        cancelled: false,
        outputTruncated: truncated,
      };
    } finally {
      if (!sessionDeleted) {
        await this.deleteProcessSession(providerResourceId, sessionId).catch(() => undefined);
      }
    }
  }

  private async deleteProcessSession(
    providerResourceId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.toolboxFetch(
      providerResourceId,
      `/process/session/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        signal: deadlineSignal(signal, undefined, this.requestTimeoutMs),
      },
    );
    if (response.status === 404) return;
    if (!response.ok) throw await this.toolboxError(providerResourceId, response);
  }

  async readFile(input: ProviderReadFileInput): Promise<ProviderReadFileResult> {
    const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
    const offsetBytes = input.offsetBytes ?? 0;
    if (maxBytes < 1 || maxBytes > MAX_FILE_BYTES || offsetBytes < 0) {
      throw new ProviderError("Invalid Daytona file read range", "invalid_request", false);
    }
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const providerPath = daytonaPath(input.path);
    const info = DaytonaFileInfoSchema.parse(
      await this.toolboxJson(
        input.providerResourceId,
        `/files/info?path=${encodeURIComponent(providerPath)}`,
        { method: "GET", signal },
      ),
    );
    const response = await this.toolboxFetch(
      input.providerResourceId,
      `/files/download?path=${encodeURIComponent(providerPath)}`,
      {
        method: "GET",
        headers: { range: `bytes=${offsetBytes}-${offsetBytes + maxBytes - 1}` },
        signal,
      },
    );
    if (!response.ok) throw await this.toolboxError(input.providerResourceId, response);
    if (response.status !== 206 && info.size > MAX_FILE_BYTES) {
      await response.body?.cancel();
      throw new ProviderError(
        "Daytona download does not support a bounded range for this file",
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
      throw new ProviderError("Daytona write exceeds provider limit", "invalid_request", false);
    }
    if (input.mode === "append") {
      throw new ProviderError(
        "Daytona does not natively support append writes",
        "unsupported",
        false,
      );
    }
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const providerPath = daytonaPath(input.path);
    const existed = await this.toolboxExists(input.providerResourceId, providerPath, signal);
    if (input.mode === "create" && existed) {
      throw new ProviderError("Daytona file already exists", "customer", false);
    }
    if (input.createParents === false) {
      const parent = providerPath.slice(0, providerPath.lastIndexOf("/")) || ".";
      if (!(await this.toolboxExists(input.providerResourceId, parent, signal))) {
        throw new ProviderError("Daytona parent directory does not exist", "customer", false);
      }
    } else if (input.createParents === true) {
      const parent = providerPath.slice(0, providerPath.lastIndexOf("/")) || ".";
      const query = new URLSearchParams({ path: parent, mode: "755" });
      await this.toolboxJson(input.providerResourceId, `/files/folder?${query}`, {
        method: "POST",
        signal,
      });
    }
    const form = new FormData();
    form.set("file", new Blob([bytes.slice().buffer]), providerPath.split("/").at(-1) || "file");
    const response = await this.toolboxFetch(
      input.providerResourceId,
      `/files/upload?path=${encodeURIComponent(providerPath)}`,
      {
        method: "POST",
        body: form,
        signal,
      },
    );
    if (!response.ok) throw await this.toolboxError(input.providerResourceId, response);
    return { path: input.path, bytesWritten: bytes.length, created: !existed };
  }

  async listFiles(input: ProviderListFilesInput): Promise<ProviderListFilesResult> {
    const maxEntries = input.maxEntries ?? MAX_LIST_ENTRIES;
    if (maxEntries < 1 || maxEntries > MAX_LIST_ENTRIES) {
      throw new ProviderError("Invalid Daytona list limit", "invalid_request", false);
    }
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const providerPath = daytonaPath(input.path);
    const response = await this.toolboxJson(
      input.providerResourceId,
      `/files?path=${encodeURIComponent(providerPath)}&depth=${input.recursive ? 1_000 : 1}`,
      { method: "GET", signal },
    );
    const all = z.array(DaytonaFileInfoSchema).parse(response);
    const base = input.path === "/" ? "" : input.path.replace(/\/$/, "");
    const entries = all.slice(0, maxEntries).map((entry): ProviderFileEntry => ({
      path: entry.name.startsWith("/") ? entry.name : `${base}/${entry.name}`,
      type: entry.isDir ? "directory" : entry.mode?.startsWith("l") ? "symlink" : "file",
      sizeBytes: entry.size,
      modifiedAt:
        entry.modifiedAt || entry.modTime
          ? new Date(entry.modifiedAt ?? entry.modTime ?? "")
          : null,
    }));
    return { entries, truncated: all.length > maxEntries };
  }

  async deleteFile(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult> {
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const providerPath = daytonaPath(input.path);
    if (!(await this.toolboxExists(input.providerResourceId, providerPath, signal))) {
      return { path: input.path, deleted: false };
    }
    const response = await this.toolboxFetch(
      input.providerResourceId,
      `/files?path=${encodeURIComponent(providerPath)}&recursive=${String(input.recursive ?? false)}`,
      { method: "DELETE", signal },
    );
    if (!response.ok) throw await this.toolboxError(input.providerResourceId, response);
    return { path: input.path, deleted: true };
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const organizationId =
      input.providerOrganizationId ?? this.organizationId ?? (await this.discoverOrganizationId());
    const query = new URLSearchParams({
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    });
    const response = await this.analyticsRequest(
      `/organization/${encodeURIComponent(organizationId)}/usage/sandbox?${query}`,
      input.signal,
    );
    const rows = z
      .array(
        z
          .object({
            sandboxId: z.string(),
            totalPrice: z.number().nonnegative(),
            lastEnd: z.string().optional().nullable(),
          })
          .passthrough(),
      )
      .parse(response);
    const row = rows.find((candidate) => candidate.sandboxId === input.providerResourceId);
    if (!row) {
      return null;
    }
    return {
      amountMicrousd: BigInt(Math.round(row.totalPrice * 1_000_000)),
      providerOrganizationId: organizationId,
      measuredThrough: row.lastEnd ? new Date(row.lastEnd) : input.to,
      provenance: "provider_reported",
      confidence: "high",
      source: "daytona-analytics-sandbox-usage",
      raw: row,
    };
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
      allowConflict: true,
    });
    this.toolboxUrls.delete(providerResourceId);
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}/pause`, {
      method: "POST",
      signal,
    });
  }

  async inspect(
    providerResourceId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandboxInspection> {
    let response: unknown;
    try {
      response = await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}`, {
        method: "GET",
        signal,
      });
    } catch (error) {
      if (error instanceof DaytonaRequestError && error.status === 404) {
        this.toolboxUrls.delete(providerResourceId);
        return { state: "absent", providerState: null, reason: null };
      }
      throw error;
    }
    const sandbox = DaytonaSandboxSchema.parse(response);
    return {
      state: daytonaSandboxState(sandbox.state),
      providerState: sandbox.state ?? null,
      reason: sandbox.errorReason ? (boundedDetail(sandbox.errorReason) ?? null) : null,
    };
  }

  async discoverRuntimeCapabilities(providerResourceId: string, signal?: AbortSignal) {
    const requestSignal = deadlineSignal(signal, undefined, this.requestTimeoutMs);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.toolboxJson(providerResourceId, "/computeruse/status", {
          method: "GET",
          signal: requestSignal,
        });
        const runtime = this.capabilities.runtime ?? {};
        if (!runtime.computer?.recording) {
          return runtime;
        }
        const recordingAvailable = await this.hasRecordingPrerequisites(
          providerResourceId,
          requestSignal,
        ).catch(() => false);
        if (recordingAvailable) return runtime;
        const { recording: _recording, ...computer } = runtime.computer;
        return { ...runtime, computer };
      } catch (error) {
        if (isToolboxNotFound(error)) {
          const { computer: _computer, ...runtime } = this.capabilities.runtime ?? {};
          return runtime;
        }
        if (error instanceof DaytonaRequestError && error.status === 503) {
          if (attempt < 4) {
            await abortableDelay(250 * 2 ** attempt, requestSignal);
            continue;
          }
          const { computer: _computer, ...runtime } = this.capabilities.runtime ?? {};
          return runtime;
        }
        throw error;
      }
    }
    return this.capabilities.runtime ?? {};
  }

  private async hasRecordingPrerequisites(
    providerResourceId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const execution = await this.exec({
      providerResourceId,
      command: ["sh", "-lc", "command -v ffmpeg >/dev/null 2>&1"],
      maxOutputBytes: 1_024,
      signal,
    });
    for await (const event of execution.events) {
      if (event.type === "exit") return event.exitCode === 0;
    }
    return false;
  }

  async executeComputerAction(input: ProviderComputerActionInput): Promise<void> {
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    await this.ensureComputerUse(input.providerResourceId, signal);
    const action = input.action;
    const routes = {
      mouse_move: "/computeruse/mouse/move",
      mouse_click: "/computeruse/mouse/click",
      mouse_drag: "/computeruse/mouse/drag",
      mouse_scroll: "/computeruse/mouse/scroll",
      keyboard_type: "/computeruse/keyboard/type",
      keyboard_key: "/computeruse/keyboard/key",
      keyboard_hotkey: "/computeruse/keyboard/hotkey",
    } as const;
    const body =
      action.type === "keyboard_type"
        ? { text: action.text, delay: action.delayMs }
        : action.type === "keyboard_key"
          ? { key: action.key, modifiers: action.modifiers }
          : action.type === "keyboard_hotkey"
            ? { keys: action.keys }
            : action.type === "mouse_drag"
              ? {
                  startX: action.startX,
                  startY: action.startY,
                  endX: action.endX,
                  endY: action.endY,
                  button: action.button,
                }
              : action;
    await this.toolboxJson(input.providerResourceId, routes[action.type], {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
  }

  async captureComputerScreenshot(
    input: ProviderComputerScreenshotInput,
  ): Promise<ProviderComputerScreenshot> {
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    await this.ensureComputerUse(input.providerResourceId, signal);
    const compressed =
      input.format === "jpeg" || input.quality !== undefined || input.scale !== undefined;
    const path = `/computeruse/screenshot${input.region ? "/region" : ""}${
      compressed ? "/compressed" : ""
    }`;
    const query = new URLSearchParams();
    query.set("showCursor", String(input.showCursor ?? false));
    if (input.format) query.set("format", input.format);
    if (input.quality !== undefined) query.set("quality", String(input.quality));
    if (input.scale !== undefined) query.set("scale", String(input.scale));
    if (input.region) {
      query.set("x", String(input.region.x));
      query.set("y", String(input.region.y));
      query.set("width", String(input.region.width));
      query.set("height", String(input.region.height));
    }
    const screenshot = DaytonaScreenshotSchema.parse(
      await this.toolboxJson(input.providerResourceId, `${path}?${query}`, {
        method: "GET",
        signal,
      }),
    );
    const data = Uint8Array.from(Buffer.from(screenshot.screenshot, "base64"));
    if (data.byteLength > MAX_FILE_BYTES) {
      throw new ProviderError("Daytona screenshot exceeds provider limit", "unsupported", false);
    }
    return {
      format: input.format ?? "png",
      data,
      cursorPosition: screenshot.cursorPosition,
    };
  }

  async startComputerRecording(
    input: ProviderStartRecordingInput,
  ): Promise<ProviderComputerRecording> {
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    await this.ensureComputerUse(input.providerResourceId, signal);
    const recording = DaytonaRecordingSchema.parse(
      await this.toolboxJson(input.providerResourceId, "/computeruse/recordings/start", {
        method: "POST",
        body: JSON.stringify({ label: input.recordingKey }),
        signal,
      }),
    );
    return daytonaRecording(recording, "recording");
  }

  async stopComputerRecording(
    input: ProviderStopRecordingInput,
  ): Promise<ProviderComputerRecording> {
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const recording = DaytonaRecordingSchema.parse(
      await this.toolboxJson(input.providerResourceId, "/computeruse/recordings/stop", {
        method: "POST",
        body: JSON.stringify({ id: input.recordingId }),
        signal,
      }),
    );
    return daytonaRecording(recording, "stopped");
  }

  async reconcileComputerRecording(
    input: ProviderReconcileRecordingInput,
  ): Promise<ProviderComputerRecording | null> {
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    try {
      if (input.recordingId) {
        const recording = DaytonaRecordingSchema.parse(
          await this.toolboxJson(
            input.providerResourceId,
            `/computeruse/recordings/${encodeURIComponent(input.recordingId)}`,
            { method: "GET", signal },
          ),
        );
        return daytonaRecording(recording, daytonaRecordingState(recording.status));
      }
      const response = DaytonaRecordingsSchema.parse(
        await this.toolboxJson(input.providerResourceId, "/computeruse/recordings", {
          method: "GET",
          signal,
        }),
      );
      const recording = response.recordings.find(
        (candidate) =>
          candidate.label === input.recordingKey ||
          candidate.fileName?.includes(input.recordingKey) === true,
      );
      return recording
        ? daytonaRecording(recording, daytonaRecordingState(recording.status))
        : null;
    } catch (error) {
      if (isToolboxNotFound(error)) return null;
      throw error;
    }
  }

  private rememberSandbox(sandbox: z.infer<typeof DaytonaSandboxSchema>): void {
    this.organizationId = sandbox.organizationId;
    if (sandbox.toolboxProxyUrl) {
      this.toolboxUrls.set(sandbox.id, this.resolveToolboxUrl(sandbox.toolboxProxyUrl, sandbox.id));
    }
  }

  private async waitUntilStarted(
    sandbox: z.infer<typeof DaytonaSandboxSchema>,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<typeof DaytonaSandboxSchema>> {
    const deadline = Date.now() + this.imageReadyTimeoutMs;
    let current = sandbox;
    while (current.state && current.state !== "started") {
      if (DAYTONA_FAILED_STATES.has(current.state)) {
        await this.destroy(current.id, signal).catch(() => undefined);
        throw new ProviderError(
          current.errorReason
            ? `Daytona image build failed: ${current.errorReason}`
            : `Daytona image build failed (${current.state})`,
          "customer",
          false,
        );
      }
      if (!DAYTONA_PENDING_STATES.has(current.state)) {
        throw new ProviderError(
          `Daytona sandbox entered ${current.state} before it started`,
          "unavailable",
          true,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ProviderError(
          "Daytona sandbox image was not ready before the deadline",
          "unknown_outcome",
          true,
        );
      }
      await abortableDelay(
        Math.min(IMAGE_POLL_INTERVAL_MS, remaining),
        signal ?? AbortSignal.timeout(remaining),
      );
      current = DaytonaSandboxSchema.parse(
        await this.request(`/sandbox/${encodeURIComponent(current.id)}`, {
          method: "GET",
          signal,
        }),
      );
    }
    return current;
  }

  private resolveToolboxUrl(proxyUrl: string, providerResourceId: string): string {
    if (proxyUrl.includes("{sandboxId}")) {
      return proxyUrl
        .replace("{sandboxId}", encodeURIComponent(providerResourceId))
        .replace(/\/$/, "");
    }
    const trimmed = proxyUrl.replace(/\/$/, "");
    return trimmed.endsWith(`/${providerResourceId}`)
      ? trimmed
      : `${trimmed}/${encodeURIComponent(providerResourceId)}`;
  }

  private async toolboxUrl(providerResourceId: string, signal: AbortSignal): Promise<string> {
    const cached = this.toolboxUrls.get(providerResourceId);
    if (cached) return cached;
    let response: unknown;
    try {
      response = await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}`, {
        method: "GET",
        signal,
      });
    } catch (error) {
      if (error instanceof DaytonaRequestError && error.status === 404) {
        throw new DaytonaRequestError(404, "API", {
          code: error.code,
          detail: error.detail,
          sandboxUnavailable: true,
        });
      }
      throw error;
    }
    const sandbox = DaytonaSandboxSchema.parse(response);
    if (!sandbox.toolboxProxyUrl) {
      throw new ProviderError("Daytona sandbox has no toolbox proxy URL", "unsupported", false);
    }
    const url = this.resolveToolboxUrl(sandbox.toolboxProxyUrl, providerResourceId);
    this.toolboxUrls.set(providerResourceId, url);
    return url;
  }

  private async toolboxError(
    providerResourceId: string,
    response: Response,
  ): Promise<DaytonaRequestError> {
    const error = await daytonaRequestError(response, "toolbox");
    // The toolbox proxy's codes for a stopped or deleted sandbox vary between proxies, so
    // a 400 or 404 that did not come from the in-sandbox daemon is checked against the API.
    if (
      (error.status !== 400 && error.status !== 404) ||
      error.sandboxUnavailable ||
      error.fromDaemon
    ) {
      return error;
    }
    const inspection = await this.inspect(providerResourceId).catch(() => null);
    if (!inspection || !LOST_SANDBOX_STATES.has(inspection.state)) return error;
    return new DaytonaRequestError(error.status, "toolbox", {
      code: error.code,
      detail: error.detail,
      sandboxUnavailable: true,
    });
  }

  private async toolboxFetch(
    providerResourceId: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const signal = init.signal as AbortSignal;
    const baseUrl = await this.toolboxUrl(providerResourceId, signal);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.apiKey}`);
    headers.set("accept", "application/json");
    headers.set("x-daytona-sdk-version", "0.163.0");
    headers.set("x-daytona-split-output", "true");
    return this.fetchImpl(`${baseUrl}${path}`, { ...init, headers });
  }

  private async toolboxJson(
    providerResourceId: string,
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.toolboxFetch(providerResourceId, path, { ...init, headers });
    if (!response.ok) throw await this.toolboxError(providerResourceId, response);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async toolboxCommandLogs(
    providerResourceId: string,
    path: string,
    init: RequestInit,
  ): Promise<z.infer<typeof DaytonaCommandLogsSchema>> {
    const response = await this.toolboxFetch(providerResourceId, path, init);
    if (!response.ok) throw await this.toolboxError(providerResourceId, response);
    const text = await response.text();
    const contentType = response.headers.get("content-type");
    const structured = contentType?.toLowerCase().includes("application/json") === true;
    return DaytonaCommandLogsSchema.parse(
      structured ? (text ? JSON.parse(text) : {}) : { output: text },
    );
  }

  private async ensureComputerUse(providerResourceId: string, signal: AbortSignal): Promise<void> {
    await this.toolboxJson(providerResourceId, "/computeruse/start", {
      method: "POST",
      signal,
    });
  }

  private async toolboxExists(
    providerResourceId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = await this.toolboxFetch(
      providerResourceId,
      `/files/info?path=${encodeURIComponent(path)}`,
      { method: "GET", signal },
    );
    if (!response.ok) {
      const error = await this.toolboxError(providerResourceId, response);
      if (isToolboxNotFound(error)) return false;
      throw error;
    }
    return true;
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      allowConflict?: boolean;
      idempotencyKey?: string;
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
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return {};
    }
    if (options.allowConflict && response.status === 409) {
      return {};
    }
    if (!response.ok) {
      throw await daytonaRequestError(response, "API");
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async analyticsRequest(path: string, callerSignal?: AbortSignal): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.analyticsApiUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) {
      throw await daytonaRequestError(response, "analytics");
    }
    return response.json();
  }

  private async discoverOrganizationId(): Promise<string> {
    const response = await this.request("/sandbox", { method: "GET" });
    const rows = z
      .union([
        z.array(z.object({ organizationId: z.string().min(1) }).passthrough()),
        z.object({
          items: z.array(z.object({ organizationId: z.string().min(1) }).passthrough()),
        }),
      ])
      .parse(response);
    const organizationId = Array.isArray(rows)
      ? rows[0]?.organizationId
      : rows.items[0]?.organizationId;
    if (!organizationId) {
      throw new Error("Daytona organization could not be discovered");
    }
    this.organizationId = organizationId;
    return organizationId;
  }
}

function daytonaImageSpec(input: ProviderCreateSandboxInput): {
  cpu: number;
  memoryGb: number;
  diskGb: number;
} | null {
  if (!input.image) return null;
  if (!OCI_IMAGE_REFERENCE.test(input.image)) {
    throw new ProviderError("Daytona OCI image reference is invalid", "invalid_request", false);
  }
  return {
    cpu: input.resources.vcpu,
    memoryGb: Math.max(1, Math.ceil(input.resources.memoryMb / 1024)),
    diskGb:
      input.resources.diskMb === undefined
        ? DAYTONA_IMAGE_DISK_GB
        : Math.max(1, Math.ceil(input.resources.diskMb / 1024)),
  };
}

function daytonaRecording(
  recording: z.infer<typeof DaytonaRecordingSchema>,
  state: "recording" | "stopped",
): ProviderComputerRecording {
  return {
    recordingId: recording.id,
    state,
    format: "mp4",
    filePath: recording.filePath?.startsWith("/") ? recording.filePath : undefined,
    sizeBytes: recording.sizeBytes,
    durationSeconds: recording.durationSeconds,
    startedAt: recording.startTime ? new Date(recording.startTime) : undefined,
    stoppedAt: recording.endTime ? new Date(recording.endTime) : undefined,
  };
}

function daytonaRecordingState(status: string): "recording" | "stopped" {
  return /^(completed|finished|stopped)$/i.test(status) ? "stopped" : "recording";
}

function daytonaSandboxState(state: string | undefined): ProviderSandboxState {
  switch (state) {
    case "started":
      return "running";
    case "creating":
    case "restoring":
    case "starting":
    case "resuming":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
      return "starting";
    case "pausing":
    case "paused":
      return "paused";
    case "stopping":
    case "stopped":
    case "archiving":
    case "archived":
      return "stopped";
    case "destroying":
    case "destroyed":
      return "absent";
    case "error":
    case "build_failed":
      return "failed";
    default:
      return "unknown";
  }
}

function daytonaFailureKind(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "capacity";
  if (status >= 500) return "unavailable";
  if (status === 404 || status === 409) return "customer";
  return "invalid_request";
}

function isToolboxNotFound(error: unknown): boolean {
  return error instanceof DaytonaRequestError && error.status === 404 && !error.sandboxUnavailable;
}

async function daytonaRequestError(
  response: Response,
  surface: DaytonaSurface,
): Promise<DaytonaRequestError> {
  const text = await readErrorText(response);
  let body: z.infer<typeof DaytonaErrorBodySchema> | undefined;
  try {
    const parsed = DaytonaErrorBodySchema.safeParse(text ? JSON.parse(text) : undefined);
    body = parsed.success ? parsed.data : undefined;
  } catch {
    body = undefined;
  }
  const code = body?.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code) ? body.code : undefined;
  const message = Array.isArray(body?.message) ? body.message.join("; ") : body?.message;
  return new DaytonaRequestError(response.status, surface, {
    code,
    detail: boundedDetail(message),
    fromDaemon: body?.source === "DAYTONA_DAEMON",
  });
}

async function readErrorText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < MAX_ERROR_BODY_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(length, MAX_ERROR_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function boundedDetail(value: string | undefined): string | undefined {
  const detail = value?.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  return detail.length > MAX_ERROR_DETAIL_CHARS
    ? `${detail.slice(0, MAX_ERROR_DETAIL_CHARS - 3)}...`
    : detail;
}

function daytonaSessionCommand(input: ProviderExecInput): string {
  const command = input.command.map(shellQuote).join(" ");
  const environment = Object.entries(input.environment ?? {}).map(([key, value]) => {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new ProviderError(
        "Invalid Daytona environment variable name",
        "invalid_request",
        false,
      );
    }
    return `${key}=${shellQuote(value)}`;
  });
  const invoked = environment.length > 0 ? `env ${environment.join(" ")} ${command}` : command;
  const cd = input.cwd ? `cd -- ${shellQuote(input.cwd)} && ` : "";
  return `${DAYTONA_LAUNCHER_FUNCTION} ${cd}${DAYTONA_LAUNCHER} ${invoked}`;
}

function encodeExecutionId(sessionId: string, commandId: string): string {
  const encoded = Buffer.from(JSON.stringify([sessionId, commandId])).toString("base64url");
  return `${DAYTONA_EXECUTION_ID_PREFIX}${encoded}`;
}

function decodeExecutionId(executionId: string): { sessionId: string; commandId: string } {
  try {
    if (!executionId.startsWith(DAYTONA_EXECUTION_ID_PREFIX)) throw new Error("invalid prefix");
    const decoded = JSON.parse(
      Buffer.from(executionId.slice(DAYTONA_EXECUTION_ID_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
    const [sessionId, commandId] = z.tuple([z.string().min(1), z.string().min(1)]).parse(decoded);
    return { sessionId, commandId };
  } catch {
    throw new ProviderError("Invalid Daytona execution ID", "invalid_request", false);
  }
}

function daytonaPath(path: string): string {
  if (path === "/workspace") return "workspace";
  return path.startsWith("/workspace/") ? path.slice(1) : path;
}

function splitDaytonaOutput(output: string): { stdout: string; stderr: string } {
  if (output.length === 0) return { stdout: "", stderr: "" };
  const stdoutMarker = "\x01\x01\x01";
  const stderrMarker = "\x02\x02\x02";
  let stream: "stdout" | "stderr" | undefined;
  let stdout = "";
  let stderr = "";
  for (let offset = 0; offset < output.length;) {
    if (output.startsWith(stdoutMarker, offset)) {
      stream = "stdout";
      offset += stdoutMarker.length;
      continue;
    }
    if (output.startsWith(stderrMarker, offset)) {
      stream = "stderr";
      offset += stderrMarker.length;
      continue;
    }
    if (!stream) {
      throw new ProviderError(
        "Daytona did not return separable stdout and stderr",
        "unsupported",
        false,
      );
    }
    if (stream === "stdout") stdout += output[offset];
    else stderr += output[offset];
    offset += 1;
  }
  return { stdout, stderr };
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderError("Daytona file response exceeds the read limit", "unsupported", false);
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
        "Daytona file response exceeded the streaming read limit",
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
