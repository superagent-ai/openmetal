import { expect, it, vi } from "vitest";
import { ModalSandboxProvider } from "../src/index.js";

it("declares the Modal provider contract", () => {
  const provider = new ModalSandboxProvider({ tokenId: "test", tokenSecret: "test" });
  expect(provider.name).toBe("modal");
  expect(provider.capabilities.pause).toBe(false);
  expect(provider.capabilities.runtime).toMatchObject({
    process: { exec: true, streams: true, cancel: false },
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
});

it("rejects oversized Modal files before readBytes buffers them", async () => {
  const filesystem = {
    stat: vi.fn().mockResolvedValue({ size: 10 * 1_024 * 1_024 + 1 }),
    readBytes: vi.fn(),
  };
  const client = {
    sandboxes: { fromId: vi.fn().mockResolvedValue({ filesystem }) },
  };
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: client as never,
  });

  await expect(
    provider.readFile({ providerResourceId: "sandbox-1", path: "/tmp/large.bin" }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  expect(filesystem.readBytes).not.toHaveBeenCalled();
});

function byteStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

it("streams Modal exec stdout, stderr, and exit", async () => {
  const stdin = {
    writeBytes: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const process = {
    stdin,
    stdout: byteStream("hello"),
    stderr: byteStream("warn"),
    wait: vi.fn().mockResolvedValue(3),
  };
  const sandbox = {
    exec: vi.fn().mockResolvedValue(process),
  };
  const client = {
    sandboxes: { fromId: vi.fn().mockResolvedValue(sandbox) },
  };
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: client as never,
  });

  const result = await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["printf", "hello"],
    stdin: "input",
  });
  const events = [];
  for await (const event of result.events) events.push(event);
  expect(events.map((event) => event.type).sort()).toEqual(["exit", "stderr", "stdout"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 3 });
  expect(stdin.writeBytes).toHaveBeenCalledOnce();
  expect(stdin.close).toHaveBeenCalledOnce();
});

it("rounds deadline-derived Modal exec timeouts down to whole seconds", async () => {
  const process = {
    stdin: { writeBytes: vi.fn(), close: vi.fn() },
    stdout: byteStream(""),
    stderr: byteStream(""),
    wait: vi.fn().mockResolvedValue(0),
  };
  const sandbox = { exec: vi.fn().mockResolvedValue(process) };
  const client = { sandboxes: { fromId: vi.fn().mockResolvedValue(sandbox) } };
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: client as never,
  });
  const remaining = 59_999;

  await provider.exec({
    providerResourceId: "sandbox-1",
    command: ["true"],
    deadline: new Date(Date.now() + remaining),
  });

  const timeoutMs = sandbox.exec.mock.calls[0]?.[1]?.timeoutMs;
  expect(timeoutMs).toBeGreaterThanOrEqual(58_000);
  expect(timeoutMs).toBeLessThanOrEqual(remaining);
  expect(timeoutMs % 1_000).toBe(0);
});

it("uses Modal native filesystem methods for portable file operations", async () => {
  const filesystem = {
    stat: vi.fn().mockResolvedValue({
      name: "a.txt",
      path: "/tmp/a.txt",
      type: "file",
      size: 6,
      modifiedTime: 1_787_826_400,
    }),
    readBytes: vi.fn().mockResolvedValue(new TextEncoder().encode("abcdef")),
    listFiles: vi.fn().mockResolvedValue([
      {
        name: "a.txt",
        path: "/tmp/a.txt",
        type: "file",
        size: 6,
        modifiedTime: 1_787_826_400,
      },
    ]),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const sandbox = { filesystem };
  const client = {
    sandboxes: { fromId: vi.fn().mockResolvedValue(sandbox) },
  };
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: client as never,
  });

  await expect(
    provider.readFile({
      providerResourceId: "sandbox-1",
      path: "/tmp/a.txt",
      offsetBytes: 2,
      maxBytes: 2,
      encoding: "utf8",
    }),
  ).resolves.toMatchObject({ data: "cd", sizeBytes: 6, truncated: true });
  await expect(
    provider.listFiles({ providerResourceId: "sandbox-1", path: "/tmp" }),
  ).resolves.toMatchObject({
    entries: [{ path: "/tmp/a.txt", type: "file", sizeBytes: 6 }],
    truncated: false,
  });
  await expect(
    provider.deleteFile({ providerResourceId: "sandbox-1", path: "/tmp/a.txt" }),
  ).resolves.toEqual({ path: "/tmp/a.txt", deleted: true });
});
