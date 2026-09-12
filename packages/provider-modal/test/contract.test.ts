import { expect, it, vi } from "vitest";
import { ModalSandboxProvider } from "../src/index.js";

it("declares the Modal provider contract", () => {
  const provider = new ModalSandboxProvider({ tokenId: "test", tokenSecret: "test" });
  expect(provider.name).toBe("modal");
  expect(provider.capabilities.pause).toBe(false);
  expect(provider.capabilities.cost).toBe(true);
  expect(provider.capabilities.sizing).toBe("direct");
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

it("applies Metal vCPU and memory requests to Modal sandboxes", async () => {
  const app = { appId: "app-1" };
  const image = {};
  const sandbox = {
    sandboxId: "sandbox-1",
    exec: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue(0) }),
  };
  const client = {
    apps: { fromName: vi.fn().mockResolvedValue(app) },
    images: { fromRegistry: vi.fn().mockReturnValue(image) },
    sandboxes: { create: vi.fn().mockResolvedValue(sandbox) },
  };
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: client as never,
  });

  const created = await provider.create({
    metalSandboxId: "sbx_1",
    organizationId: "org-1",
    projectId: "prj_1",
    language: "typescript",
    ttlMinutes: 30,
    source: { kind: "environment", environment: "metal/node" },
    resources: { vcpu: 4, memoryMb: 4096, architecture: "x86_64" },
    lifecycle: {
      runtimeTimeoutSeconds: 1_800,
      onRuntimeTimeout: "destroy",
      onIdleTimeout: "destroy",
    },
  });

  expect(client.sandboxes.create).toHaveBeenCalledWith(
    app,
    image,
    expect.objectContaining({
      cpu: 2,
      memoryMiB: 4096,
      timeoutMs: 1_800_000,
    }),
  );
  expect(created.resolvedResources).toMatchObject({ vcpu: 4, memoryMb: 4096 });
});

it("derives cumulative Modal cost from provider resource usage", async () => {
  const sandboxGetResourceUsage = vi.fn().mockResolvedValue({
    cpuCoreNanosecs: 100_000_000_000,
    memGibNanosecs: 100_000_000_000,
    gpuNanosecs: 0,
  });
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: { cpClient: { sandboxGetResourceUsage } } as never,
  });
  const measuredThrough = new Date("2026-09-11T12:00:00.000Z");

  await expect(
    provider.getCost({
      providerResourceId: "sandbox-1",
      providerOrganizationId: "app-1",
      from: new Date("2026-09-11T11:00:00.000Z"),
      to: measuredThrough,
    }),
  ).resolves.toMatchObject({
    amountMicrousd: 4_609n,
    providerOrganizationId: "app-1",
    measuredThrough,
    provenance: "provider_metered",
    confidence: "medium",
    source: "modal-sandbox-resource-usage-published-rate-card",
    rateCardVersion: "2026-09-11",
  });
  expect(sandboxGetResourceUsage).toHaveBeenCalledWith({ sandboxId: "sandbox-1" });
});

it("captures final Modal usage before termination for reconciliation", async () => {
  const terminate = vi.fn().mockResolvedValue(undefined);
  const sandboxGetResourceUsage = vi.fn().mockResolvedValue({
    cpuCoreNanosecs: 1_000_000_000,
    memGibNanosecs: 2_000_000_000,
    gpuNanosecs: 0,
  });
  const provider = new ModalSandboxProvider({
    tokenId: "test",
    tokenSecret: "test",
    client: {
      cpClient: { sandboxGetResourceUsage },
      sandboxes: { fromId: vi.fn().mockResolvedValue({ terminate }) },
    } as never,
  });

  const destroyed = await provider.destroy("sandbox-1");
  expect(terminate).toHaveBeenCalledOnce();
  expect(destroyed).toMatchObject({
    providerMetadata: {
      modal: {
        finalResourceUsage: {
          cpuCoreNanosecs: 1_000_000_000,
          memGibNanosecs: 2_000_000_000,
          gpuNanosecs: 0,
        },
      },
    },
  });

  sandboxGetResourceUsage.mockClear();
  await expect(
    provider.getCost({
      providerResourceId: "sandbox-1",
      providerOrganizationId: "app-1",
      providerMetadata: destroyed?.providerMetadata,
      from: new Date("2026-09-11T11:00:00.000Z"),
      to: new Date("2026-09-11T12:00:00.000Z"),
    }),
  ).resolves.toMatchObject({ amountMicrousd: 53n });
  expect(sandboxGetResourceUsage).not.toHaveBeenCalled();
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
