import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import type { ProviderExecEvent } from "@openmetal/provider-core";
import { VercelSandboxProvider } from "../src/index.js";

it("declares the Vercel provider contract", () => {
  const provider = new VercelSandboxProvider({ token: "test", projectId: "test" });
  expect(provider.name).toBe("vercel");
  expect(provider.capabilities.pause).toBe(false);
  expect(provider.capabilities.runtime).toEqual({
    process: {
      exec: true,
      streams: true,
      cancel: false,
      maxOutputBytes: 10 * 1_024 * 1_024,
    },
    files: {
      read: true,
      write: true,
      writeModes: ["create", "overwrite"],
      createParents: true,
      list: false,
      delete: false,
      maxReadBytes: 10 * 1_024 * 1_024,
      maxWriteBytes: 10 * 1_024 * 1_024,
      maxListEntries: 0,
    },
  });
  expect(provider.listFiles).toBeUndefined();
  expect(provider.deleteFile).toBeUndefined();
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
  expect(provider.cancelExec).toBeUndefined();
});

it("marks Vercel session calculations as rate-card estimated", async () => {
  const evidence = sandboxResponse();
  const session = {
    ...evidence.session,
    duration: 60_000,
    activeCpuDurationMs: 30_000,
    stoppedAt: Date.parse("2026-08-27T10:01:00.000Z"),
  };
  const provider = new VercelSandboxProvider({ token: "test", projectId: "project-1" });

  const cost = await provider.getCost({
    providerResourceId: "sandbox-1",
    providerMetadata: { vercel: { sandbox: evidence.sandbox, session } },
    from: new Date("2026-08-27T10:00:00.000Z"),
    to: new Date("2026-08-27T10:01:00.000Z"),
  });

  expect(cost).toMatchObject({
    provenance: "estimated_rate_card",
    confidence: "medium",
    source: "vercel-session-usage",
    rateCardVersion: "2026-08-04",
    raw: { session },
  });
});

it("uses Vercel command, log, and status REST endpoints", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    requests.push({ url: value, init });
    if (value.includes("/v2/sandboxes/sandbox-1?")) return jsonResponse(sandboxResponse());
    if (value.endsWith("/cmd")) {
      return jsonResponse({ command: { id: "cmd-1", exitCode: null } });
    }
    if (value.includes("/cmd/cmd-1/logs")) {
      return new Response(
        '{"stream":"stdout","data":"hello"}\n{"stream":"stderr","data":"warn"}\n',
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    if (value.includes("/cmd/cmd-1?wait=true")) {
      return jsonResponse({ command: { id: "cmd-1", exitCode: 3 } });
    }
    throw new Error(`unexpected request: ${value}`);
  }) as typeof fetch;
  const provider = new VercelSandboxProvider({
    token: "test",
    projectId: "project-1",
    fetchImpl,
  });
  const result = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["node", "-e", "process.exit(3)"],
    cwd: "/vercel/sandbox",
    environment: { TEST: "yes" },
    maxOutputBytes: 7,
  });
  const events = await collect(result.events);

  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(decodeOutput(events[0])).toBe("hello");
  expect(decodeOutput(events[1])).toBe("wa");
  expect(events[1]).toMatchObject({ truncated: true });
  expect(events[2]).toMatchObject({
    type: "exit",
    exitCode: 3,
    cancelled: false,
    outputTruncated: true,
  });
  const execute = requests.find((request) => request.url.endsWith("/cmd"));
  expect(JSON.parse(String(execute?.init?.body))).toEqual({
    command: "node",
    args: ["-e", "process.exit(3)"],
    cwd: "/vercel/sandbox",
    env: { TEST: "yes" },
  });
});

it("performs bounded reads and writes gzipped tar archives", async () => {
  let readCalls = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/v2/sandboxes/sandbox-1?")) return jsonResponse(sandboxResponse());
    if (value.includes("/fs/read")) {
      readCalls += 1;
      if (readCalls === 1) return new Response(null, { status: 404 });
      const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
      return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    }
    if (value.includes("/fs/write")) {
      expect(new Headers(init?.headers).get("content-type")).toBe("application/gzip");
      expect(new Headers(init?.headers).get("x-cwd")).toBe("/");
      const tar = gunzipSync(init?.body as Uint8Array);
      expect(tar.subarray(0, 16).toString("utf8").replaceAll("\0", "")).toBe("tmp/data.bin");
      expect([...tar.subarray(512, 515)]).toEqual([8, 9, 10]);
      return jsonResponse({});
    }
    throw new Error(`unexpected request: ${value}`);
  }) as typeof fetch;
  const provider = new VercelSandboxProvider({
    token: "test",
    projectId: "project-1",
    fetchImpl,
  });

  await expect(
    provider.writeFile({
      providerResourceId: "sandbox-1",
      path: "/tmp/data.bin",
      data: Uint8Array.from([8, 9, 10]),
      createParents: true,
    }),
  ).resolves.toEqual({ path: "/tmp/data.bin", bytesWritten: 3, created: true });
  await expect(
    provider.readFile({
      providerResourceId: "sandbox-1",
      path: "/tmp/data.bin",
      offsetBytes: 2,
      maxBytes: 2,
    }),
  ).resolves.toMatchObject({
    data: Uint8Array.from([2, 3]),
    sizeBytes: 5,
    eof: false,
    truncated: true,
  });
});

it("kills and confirms a Vercel command when its deadline interrupts streaming", async () => {
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    requests.push(value);
    if (value.includes("/v2/sandboxes/sandbox-1?")) return jsonResponse(sandboxResponse());
    if (value.endsWith("/cmd")) {
      return jsonResponse({ command: { id: "cmd-deadline", exitCode: null } });
    }
    if (value.includes("/cmd/cmd-deadline/logs")) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    if (value.includes("/cmd/cmd-deadline/kill")) {
      return jsonResponse({ command: { id: "cmd-deadline", exitCode: null } });
    }
    throw new Error(`unexpected request: ${value}`);
  }) as typeof fetch;
  const provider = new VercelSandboxProvider({
    token: "test",
    projectId: "project-1",
    fetchImpl,
  });
  const execution = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["sleep", "30"],
    deadline: new Date(Date.now() + 20),
  });

  await expect(collect(execution.events)).rejects.toBeDefined();
  expect(requests.some((request) => request.includes("/cmd/cmd-deadline/kill"))).toBe(true);
});

it("rejects unsupported stdin and append without transport", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const provider = new VercelSandboxProvider({
    token: "test",
    projectId: "project-1",
    fetchImpl,
  });
  await expect(
    provider.exec({
      providerResourceId: "sandbox-1",
      command: ["cat"],
      stdin: "input",
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.writeFile({
      providerResourceId: "sandbox-1",
      path: "/tmp/data",
      data: "x",
      mode: "append",
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

function sandboxResponse() {
  return {
    sandbox: {
      name: "sandbox-1",
      currentSessionId: "session-1",
      status: "running",
      persistent: false,
    },
    session: {
      id: "session-1",
      status: "running",
      vcpus: 2,
      memory: 4_096,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

async function collect(events: AsyncIterable<ProviderExecEvent>): Promise<ProviderExecEvent[]> {
  const result: ProviderExecEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function decodeOutput(event: ProviderExecEvent | undefined): string | undefined {
  return event?.type === "stdout" || event?.type === "stderr"
    ? new TextDecoder().decode(event.data)
    : undefined;
}
