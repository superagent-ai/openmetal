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
  });
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
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
