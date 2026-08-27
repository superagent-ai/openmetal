import { expect, it, vi } from "vitest";
import { CloudflareSandboxProvider } from "../src/index.js";

it("declares the Cloudflare provider contract", () => {
  const provider = new CloudflareSandboxProvider({
    apiKey: "test",
    apiUrl: "https://example.com",
  });
  expect(provider.name).toBe("cloudflare");
  expect(provider.capabilities.pause).toBe(false);
  expect(provider.capabilities.runtime).toMatchObject({
    process: { exec: true, streams: true, cancel: false },
    files: {
      read: true,
      write: true,
      writeModes: ["create", "overwrite", "append"],
      createParents: false,
      list: false,
      delete: false,
    },
  });
  expect(provider.capabilities.runtime?.httpEndpoints).toBeUndefined();
});

it("normalizes the supported Cloudflare bridge exec and file routes", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/exec")) {
      const stdout = btoa("hello");
      const stderr = btoa("warning");
      return new Response(
        `event: stdout\ndata: ${stdout}\n\nevent: stderr\ndata: ${stderr}\n\nevent: exit\ndata: {"exit_code":0}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.endsWith("/file/workspace/data.bin") && init?.method === "GET") {
      return new Response(Uint8Array.from([0, 1, 2, 3]));
    }
    if (url.endsWith("/file/workspace/new.bin") && init?.method === "GET") {
      return new Response(Uint8Array.from([1, 2]));
    }
    if (url.endsWith("/file/workspace/new.bin") && init?.method === "PUT") {
      return json({ ok: true });
    }
    return new Response("unexpected request", { status: 500 });
  });
  const provider = new CloudflareSandboxProvider({
    apiKey: "test",
    apiUrl: "https://bridge.example.com",
    fetchImpl,
  });

  const execution = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["sh", "-lc", "echo hello"],
    cwd: "/workspace",
    environment: {},
  });
  expect(await collect(execution.events)).toEqual([
    { type: "stdout", sequence: 0, data: new TextEncoder().encode("hello") },
    { type: "stderr", sequence: 1, data: new TextEncoder().encode("warning") },
    {
      type: "exit",
      sequence: 2,
      exitCode: 0,
      signal: null,
      cancelled: false,
      outputTruncated: false,
    },
  ]);
  expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
    argv: ["sh", "-lc", "echo hello"],
    cwd: "/workspace",
  });

  await expect(
    provider.readFile({
      providerResourceId: "sandbox-1",
      path: "/workspace/data.bin",
      offsetBytes: 1,
      maxBytes: 2,
    }),
  ).resolves.toMatchObject({
    data: Uint8Array.from([1, 2]),
    byteLength: 2,
    sizeBytes: 4,
    eof: false,
    truncated: true,
  });
  await expect(
    provider.writeFile({
      providerResourceId: "sandbox-1",
      path: "/workspace/new.bin",
      data: Uint8Array.from([3, 4]),
      mode: "append",
    }),
  ).resolves.toEqual({ path: "/workspace/new.bin", bytesWritten: 2, created: false });
  const write = requests.find((request) => request.init?.method === "PUT");
  expect(new Uint8Array(write?.init?.body as ArrayBuffer)).toEqual(Uint8Array.from([1, 2, 3, 4]));
});

it("bounds bridge output and rejects unsupported path and exec inputs", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    return new Response(
      `event: stdout\ndata: ${btoa("hello")}\n\nevent: exit\ndata: {"exit_code":0}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const provider = new CloudflareSandboxProvider({
    apiKey: "test",
    apiUrl: "https://bridge.example.com",
    fetchImpl,
  });
  const execution = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["echo", "hello"],
    maxOutputBytes: 3,
  });
  expect(await collect(execution.events)).toEqual([
    {
      type: "stdout",
      sequence: 0,
      data: new TextEncoder().encode("hel"),
      truncated: true,
    },
    {
      type: "exit",
      sequence: 1,
      exitCode: 0,
      signal: null,
      cancelled: false,
      outputTruncated: true,
    },
  ]);
  await expect(
    provider.readFile({ providerResourceId: "sandbox-1", path: "/tmp/file" }),
  ).rejects.toThrow("within /workspace");
  await expect(
    provider.exec({
      providerResourceId: "sandbox-1",
      command: ["env"],
      environment: { KEY: "value" },
    }),
  ).rejects.toThrow("does not support stdin or environment");
  await expect(
    provider.writeFile({
      providerResourceId: "sandbox-1",
      path: "/workspace/new/file",
      data: "x",
      createParents: true,
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
});

it("rejects oversized Cloudflare file bodies before buffering", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    return new Response(new Uint8Array(), {
      headers: { "content-length": String(10 * 1_024 * 1_024 + 1) },
    });
  });
  const provider = new CloudflareSandboxProvider({
    apiKey: "test",
    apiUrl: "https://bridge.example.com",
    fetchImpl,
  });
  await expect(
    provider.readFile({ providerResourceId: "sandbox-1", path: "/workspace/large.bin" }),
  ).rejects.toMatchObject({ kind: "unsupported" });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}
