import { expect, it, vi } from "vitest";
import { E2BSandboxProvider } from "../src/index.js";

it("declares the E2B provider contract", () => {
  const provider = new E2BSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("e2b");
  expect(provider.capabilities.resume).toBe(true);
  expect(provider.capabilities.runtime).toEqual({
    process: {
      exec: true,
      streams: true,
      cancel: false,
      maxOutputBytes: 100 * 1_024 * 1_024,
    },
    files: {
      read: true,
      write: true,
      writeModes: ["create", "overwrite"],
      createParents: true,
      list: true,
      delete: true,
      maxReadBytes: 10 * 1_024 * 1_024,
      maxWriteBytes: 10 * 1_024 * 1_024,
      maxListEntries: 10_000,
    },
    httpEndpoints: { expose: false, revoke: false },
  });
  expect(provider.cancelExec).toBeUndefined();
});

it("refuses an unbounded E2B file body larger than the adapter limit", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandboxes/sandbox-1/connect")) {
      return Response.json({
        sandboxID: "sandbox-1",
        clientID: "client-1",
        templateID: "base",
      });
    }
    if (url.endsWith("/filesystem.Filesystem/Stat")) {
      return Response.json({
        entry: {
          path: "/tmp/large.bin",
          type: "FILE_TYPE_FILE",
          size: String(10 * 1_024 * 1_024 + 1),
        },
      });
    }
    if (url.includes("/files?path=")) return new Response("ignored");
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new E2BSandboxProvider({ apiKey: "test", fetchImpl });
  await expect(
    provider.readFile({ providerResourceId: "sandbox-1", path: "/tmp/large.bin" }),
  ).rejects.toMatchObject({ kind: "unsupported" });
});

function connectStream(...messages: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = messages.map((message) => {
    const payload = encoder.encode(JSON.stringify(message));
    const frame = new Uint8Array(payload.length + 5);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    return frame;
  });
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
}

it("streams command output with separate E2B stdout and stderr", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandboxes/sandbox-1/connect")) {
      return Response.json({
        sandboxID: "sandbox-1",
        clientID: "client-1",
        templateID: "base",
        envdVersion: "0.6.2",
        envdAccessToken: "sandbox-token",
      });
    }
    if (url.endsWith("/process.Process/Start")) {
      expect(new Headers(init?.headers).get("X-Access-Token")).toBe("sandbox-token");
      return new Response(
        connectStream(
          { event: { start: { pid: 42 } } },
          {
            event: { data: { stdout: Buffer.from("hello").toString("base64"), stderr: "" } },
          },
          {
            event: { data: { stdout: "", stderr: Buffer.from("warn").toString("base64") } },
          },
          { event: { end: { exited: true, exitCode: 7 } } },
        ),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new E2BSandboxProvider({ apiKey: "test", fetchImpl });

  const result = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["sh", "-c", "echo hello"],
  });
  expect(result.executionId).toBe("42");
  const events = [];
  for await (const event of result.events) events.push(event);
  expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(events.at(-1)).toMatchObject({
    exitCode: 7,
    signal: null,
    cancelled: false,
    outputTruncated: false,
  });
});

it("accepts the current E2B lifecycle envelope and snake-case event fields", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/events/sandboxes/sandbox-1")) {
      return Response.json({
        events: [
          {
            id: "event-1",
            type: "sandbox.lifecycle.paused",
            timestamp: "2026-08-27T10:00:01.000Z",
            sandbox_execution_id: "execution-1",
            event_data: {
              execution: {
                execution_time: 1_000,
                memory_mb: 512,
                started_at: "2026-08-27T10:00:00.000Z",
                vcpu_count: 1,
              },
            },
          },
        ],
      });
    }
    if (url.endsWith("/sandboxes/sandbox-1")) {
      return Response.json({
        sandboxID: "sandbox-1",
        clientID: "client-1",
        templateID: "base",
        state: "paused",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new E2BSandboxProvider({ apiKey: "test", fetchImpl });

  const cost = await provider.getCost({
    providerResourceId: "sandbox-1",
    providerOrganizationId: "client-1",
    from: new Date("2026-08-27T10:00:00.000Z"),
    to: new Date("2026-08-27T10:00:02.000Z"),
  });

  expect(cost?.amountMicrousd).toBe(16n);
  expect(cost?.measuredThrough).toEqual(new Date("2026-08-27T10:00:02.000Z"));
  expect(cost).toMatchObject({
    provenance: "provider_metered",
    confidence: "medium",
    source: "e2b-lifecycle-events",
    rateCardVersion: "2026-08-21",
  });
});

it("marks the active E2B runtime fallback as rate-card estimated", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/events/sandboxes/sandbox-1")) {
      return Response.json({ events: [] });
    }
    if (url.endsWith("/sandboxes/sandbox-1")) {
      return Response.json({
        sandboxID: "sandbox-1",
        clientID: "client-1",
        templateID: "base",
        state: "running",
        startedAt: "2026-08-27T10:00:00.000Z",
        cpuCount: 1,
        memoryMB: 1_024,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new E2BSandboxProvider({ apiKey: "test", fetchImpl });

  const cost = await provider.getCost({
    providerResourceId: "sandbox-1",
    from: new Date("2026-08-27T10:00:00.000Z"),
    to: new Date("2026-08-27T10:00:01.000Z"),
  });

  expect(cost).toMatchObject({
    amountMicrousd: 19n,
    provenance: "estimated_rate_card",
    confidence: "low",
    source: "e2b-running-sandbox-estimate",
    rateCardVersion: "2026-08-21",
  });
});

it("returns no E2B cost while lifecycle events are not yet available", async () => {
  const provider = new E2BSandboxProvider({
    apiKey: "test",
    fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
  });

  await expect(
    provider.getCost({
      providerResourceId: "sandbox-1",
      from: new Date("2026-08-27T10:00:00.000Z"),
      to: new Date("2026-08-27T10:00:01.000Z"),
    }),
  ).resolves.toBeNull();
});

it("uses native E2B file read and list transports", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sandboxes/sandbox-1/connect")) {
      return Response.json({
        sandboxID: "sandbox-1",
        clientID: "client-1",
        templateID: "base",
        envdVersion: "0.6.2",
        envdAccessToken: "sandbox-token",
      });
    }
    if (url.endsWith("/filesystem.Filesystem/Stat")) {
      return Response.json({ entry: { path: "/tmp/a.txt", type: "FILE_TYPE_FILE", size: "6" } });
    }
    if (url.includes("/files?path=")) return new Response("abcdef");
    if (url.endsWith("/filesystem.Filesystem/ListDir")) {
      return Response.json({
        entries: [
          {
            path: "/tmp/a.txt",
            type: "FILE_TYPE_FILE",
            size: "6",
            modifiedTime: "2026-08-27T10:00:00.000Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const provider = new E2BSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    provider.readFile({
      providerResourceId: "sandbox-1",
      path: "/tmp/a.txt",
      offsetBytes: 2,
      maxBytes: 3,
      encoding: "utf8",
    }),
  ).resolves.toMatchObject({ data: "cde", sizeBytes: 6, eof: false, truncated: true });
  await expect(
    provider.listFiles({ providerResourceId: "sandbox-1", path: "/tmp" }),
  ).resolves.toMatchObject({
    entries: [{ path: "/tmp/a.txt", type: "file", sizeBytes: 6 }],
    truncated: false,
  });
});
