import { expect, it, vi } from "vitest";
import { BlaxelSandboxProvider } from "../src/index.js";

it("declares the Blaxel provider contract", () => {
  const provider = new BlaxelSandboxProvider({ apiKey: "test", workspace: "test" });
  expect(provider.name).toBe("blaxel");
  expect(provider.capabilities.cost).toBe(true);
  expect(provider.capabilities.runtime).toMatchObject({
    process: { exec: true, streams: false, cancel: true },
    files: {
      read: true,
      write: true,
      writeModes: ["create", "overwrite", "append"],
      createParents: true,
      list: true,
      delete: true,
    },
    httpEndpoints: { expose: true, revoke: true },
  });
});

it("normalizes Blaxel runtime process, file, and preview responses", async () => {
  let deleted = false;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sandboxes/sbx") && init?.method === "GET") {
      return json({
        metadata: { name: "sbx", url: "https://sbx.example.com" },
        spec: {},
        status: "DEPLOYED",
      });
    }
    if (url.endsWith("/process") && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({
        command: "'sh' '-lc' 'printf hello'",
        waitForCompletion: false,
      });
      return json({
        pid: "42",
        status: "completed",
        exitCode: 0,
        stdout: "hello",
        stderr: "warning",
      });
    }
    if (url.endsWith("/process/42/kill") && init?.method === "DELETE") {
      return json({ message: "killed" });
    }
    if (url.includes("/filesystem/tmp/data.bin?download=true") && init?.method === "GET") {
      return new Response(Uint8Array.from([0, 1, 2, 3]));
    }
    if (url.includes("/filesystem/tmp/new.bin?download=true") && init?.method === "GET") {
      return new Response("", { status: 404 });
    }
    if (url.endsWith("/filesystem/tmp") && init?.method === "PUT") {
      return json({ message: "created" });
    }
    if (url.endsWith("/filesystem-multipart/initiate/tmp/new.bin")) {
      return json({ uploadId: "upload-1" });
    }
    if (url.includes("/filesystem-multipart/upload-1/part?partNumber=1")) {
      expect(init?.body).toBeInstanceOf(FormData);
      return json({ etag: "etag-1", partNumber: 1, size: 3 });
    }
    if (url.endsWith("/filesystem-multipart/upload-1/complete")) {
      return json({ message: "completed" });
    }
    if (url.endsWith("/filesystem/tmp") && init?.method === "GET") {
      return json({
        files: [{ path: "/tmp/data.bin", size: 4, lastModified: "2026-08-27T00:00:00Z" }],
        subdirectories: [{ path: "/tmp/sub" }],
      });
    }
    if (url.includes("/filesystem/tmp/data.bin") && init?.method === "DELETE") {
      if (deleted) return new Response("", { status: 404 });
      deleted = true;
      return json({ message: "deleted" });
    }
    if (url.endsWith("/sandboxes/sbx/previews") && init?.method === "POST") {
      return json({
        metadata: { name: "metal-3000-1" },
        spec: { url: "https://preview.example.com" },
      });
    }
    if (url.endsWith("/sandboxes/sbx/previews/metal-3000-1") && init?.method === "DELETE") {
      return json({ metadata: { name: "metal-3000-1" }, spec: {} });
    }
    return new Response(`unexpected ${init?.method} ${url}`, { status: 500 });
  });
  const provider = new BlaxelSandboxProvider({
    apiKey: "test",
    workspace: "workspace",
    fetchImpl,
  });

  const execution = await provider.exec({
    providerResourceId: "sbx",
    command: ["sh", "-lc", "printf hello"],
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
  await expect(
    provider.cancelExec({ providerResourceId: "sbx", executionId: "42" }),
  ).resolves.toEqual({ executionId: "42", cancelled: true });

  await expect(
    provider.readFile({
      providerResourceId: "sbx",
      path: "/tmp/data.bin",
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
      providerResourceId: "sbx",
      path: "/tmp/new.bin",
      data: Uint8Array.from([0, 128, 255]),
      createParents: true,
    }),
  ).resolves.toEqual({ path: "/tmp/new.bin", bytesWritten: 3, created: true });
  await expect(
    provider.listFiles({ providerResourceId: "sbx", path: "/tmp", maxEntries: 2 }),
  ).resolves.toMatchObject({
    entries: [
      { path: "/tmp/data.bin", type: "file", sizeBytes: 4 },
      { path: "/tmp/sub", type: "directory", sizeBytes: null },
    ],
    truncated: false,
  });
  await expect(
    provider.deleteFile({ providerResourceId: "sbx", path: "/tmp/data.bin" }),
  ).resolves.toEqual({ path: "/tmp/data.bin", deleted: true });
  await expect(
    provider.deleteFile({ providerResourceId: "sbx", path: "/tmp/data.bin" }),
  ).resolves.toEqual({ path: "/tmp/data.bin", deleted: false });

  const lease = await provider.exposeHttpEndpoint({
    providerResourceId: "sbx",
    port: 3_000,
    path: "/health check",
    leaseDurationSeconds: 60,
  });
  expect(lease).toMatchObject({
    leaseId: "metal-3000-1",
    url: "https://preview.example.com/health%20check",
  });
  await expect(
    provider.revokeHttpEndpoint({ providerResourceId: "sbx", leaseId: lease.leaseId }),
  ).resolves.toEqual({ leaseId: "metal-3000-1", revoked: true });
});

it("keys buffered cancellation by sandbox and execution id", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const sandbox = url.includes("sbx-a") ? "sbx-a" : "sbx-b";
    if (url.includes("/sandboxes/") && init?.method === "GET") {
      return json({
        metadata: { name: sandbox, url: `https://${sandbox}.example.com` },
        spec: {},
        status: "DEPLOYED",
      });
    }
    if (url.endsWith("/process") && init?.method === "POST") {
      return json({ pid: "42", status: "completed", exitCode: 0 });
    }
    if (url.endsWith("/process/42/kill")) return json({ message: "killed" });
    return new Response("unexpected", { status: 500 });
  });
  const provider = new BlaxelSandboxProvider({
    apiKey: "test",
    workspace: "test",
    fetchImpl,
  });
  const first = await provider.exec({ providerResourceId: "sbx-a", command: ["true"] });
  const second = await provider.exec({ providerResourceId: "sbx-b", command: ["true"] });
  await provider.cancelExec({ providerResourceId: "sbx-a", executionId: "42" });

  expect((await collect(first.events)).at(-1)).toMatchObject({ cancelled: true });
  expect((await collect(second.events)).at(-1)).toMatchObject({ cancelled: false });
});

it("rejects expired runtime operations before transport", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new BlaxelSandboxProvider({
    apiKey: "test",
    workspace: "test",
    fetchImpl,
  });
  await expect(
    provider.exec({
      providerResourceId: "sbx",
      command: ["true"],
      deadline: new Date(0),
    }),
  ).rejects.toThrow("deadline exceeded");
  expect(fetchImpl).not.toHaveBeenCalled();
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
