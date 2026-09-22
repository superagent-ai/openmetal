import { z } from "zod";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderComputerActionInput,
  ProviderComputerRecording,
  ProviderComputerScreenshot,
  ProviderComputerScreenshotInput,
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

const DaytonaSandboxSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    toolboxProxyUrl: z.string().url().optional(),
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
    filePath: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .passthrough();

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
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

export type DaytonaProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  analyticsApiUrl?: string;
  organizationId?: string;
  target?: string;
  pauseSupported?: boolean;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class DaytonaRequestError extends Error {
  constructor(readonly status: number) {
    super(`Daytona request failed (${status})`);
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
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("daytona", input.resources, input.providerOptions);
    const name = `metal-${input.metalSandboxId}`;
    let response: unknown;
    try {
      response = await this.request("/sandbox", {
        method: "POST",
        body: JSON.stringify({
          name,
          ephemeral: true,
          autoDeleteInterval: 0,
          ...(input.image ? { image: input.image } : {}),
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
    const parsed = DaytonaSandboxSchema.parse(response);
    this.organizationId = parsed.organizationId;
    if (parsed.toolboxProxyUrl) {
      this.toolboxUrls.set(parsed.id, this.resolveToolboxUrl(parsed.toolboxProxyUrl, parsed.id));
    }
    return {
      providerResourceId: parsed.id,
      providerOrganizationId: parsed.organizationId,
      resolvedResources: resolved,
    };
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    try {
      const sandbox = DaytonaSandboxSchema.parse(
        await this.request(`/sandbox/${encodeURIComponent(`metal-${metalSandboxId}`)}`, {
          method: "GET",
          signal,
        }),
      );
      if (sandbox.toolboxProxyUrl) {
        this.toolboxUrls.set(
          sandbox.id,
          this.resolveToolboxUrl(sandbox.toolboxProxyUrl, sandbox.id),
        );
      }
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
        "Daytona synchronous process execution does not support stdin",
        "unsupported",
        false,
      );
    }
    const maxOutputBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new ProviderError("Invalid Daytona output limit", "invalid_request", false);
    }
    const signal = deadlineSignal(input.signal, input.deadline, this.requestTimeoutMs);
    const sessionId = `metal-${crypto.randomUUID()}`;
    await this.toolboxJson(input.providerResourceId, "/process/session", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
      signal,
    });
    let response: unknown;
    try {
      response = await this.toolboxJson(
        input.providerResourceId,
        `/process/session/${encodeURIComponent(sessionId)}/exec`,
        {
          method: "POST",
          body: JSON.stringify({
            command: daytonaSessionCommand(input),
            runAsync: false,
          }),
          signal,
        },
      );
    } finally {
      await this.toolboxJson(
        input.providerResourceId,
        `/process/session/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          signal: deadlineSignal(undefined, undefined, this.requestTimeoutMs),
        },
      );
    }
    const parsed = z
      .object({
        cmdId: z.string().min(1),
        output: z.string().nullish(),
        stdout: z.string().nullish(),
        stderr: z.string().nullish(),
        exitCode: z.number().int(),
      })
      .passthrough()
      .parse(response);
    const separated =
      parsed.stdout !== null && parsed.stdout !== undefined
        ? { stdout: parsed.stdout, stderr: parsed.stderr ?? "" }
        : splitDaytonaOutput(parsed.output ?? "");
    const stdout = new TextEncoder().encode(separated.stdout);
    const stderr = new TextEncoder().encode(separated.stderr);
    const executionId = parsed.cmdId;
    async function* events(): AsyncGenerator<ProviderExecEvent> {
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
        exitCode: parsed.exitCode,
        signal: null,
        cancelled: false,
        outputTruncated: truncated,
      };
    }
    return { executionId, events: events() };
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
    if (!response.ok) throw new DaytonaRequestError(response.status);
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
    if (!response.ok) throw new DaytonaRequestError(response.status);
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
    if (!response.ok) throw new DaytonaRequestError(response.status);
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

  async discoverRuntimeCapabilities(providerResourceId: string, signal?: AbortSignal) {
    const requestSignal = deadlineSignal(signal, undefined, this.requestTimeoutMs);
    try {
      await this.toolboxJson(providerResourceId, "/computeruse/status", {
        method: "GET",
        signal: requestSignal,
      });
      return this.capabilities.runtime ?? {};
    } catch (error) {
      if (error instanceof DaytonaRequestError && error.status === 404) {
        const { computer: _computer, ...runtime } = this.capabilities.runtime ?? {};
        return runtime;
      }
      throw error;
    }
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
        body: JSON.stringify(input.label ? { label: input.label } : {}),
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
    const sandbox = DaytonaSandboxSchema.parse(
      await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}`, {
        method: "GET",
        signal,
      }),
    );
    if (!sandbox.toolboxProxyUrl) {
      throw new ProviderError("Daytona sandbox has no toolbox proxy URL", "unsupported", false);
    }
    const url = this.resolveToolboxUrl(sandbox.toolboxProxyUrl, providerResourceId);
    this.toolboxUrls.set(providerResourceId, url);
    return url;
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
    if (!response.ok) throw new DaytonaRequestError(response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
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
    if (response.status === 404) return false;
    if (!response.ok) throw new DaytonaRequestError(response.status);
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
      throw new DaytonaRequestError(response.status);
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
      throw new DaytonaRequestError(response.status);
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
  return input.cwd ? `cd -- ${shellQuote(input.cwd)} && ${invoked}` : invoked;
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
