import { expect, it, vi } from "vitest";
import { DaytonaSandboxProvider } from "../src/index.js";

it("declares the Daytona provider contract", () => {
  const provider = new DaytonaSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("daytona");
  expect(provider.capabilities.pause).toBe(false);
  expect(provider.capabilities.runtime).toMatchObject({
    process: { exec: true, streams: false, cancel: false },
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

it("executes through a Daytona session with separate buffered stdout and stderr", async () => {
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
        runAsync: false,
      });
      return Response.json({
        cmdId: "command-1",
        output: "\x01\x01\x01hello world\x02\x02\x02warning",
        stdout: null,
        stderr: null,
        exitCode: 0,
      });
    }
    if (url.includes("/toolbox/sandbox-1/process/session/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  const result = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["printf", "%s", "hello world"],
    cwd: "/workspace",
  });
  const events = [];
  for await (const event of result.events) events.push(event);
  expect(result.executionId).toBe("command-1");
  expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(events.at(-1)).toMatchObject({ exitCode: 0, outputTruncated: false });
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
