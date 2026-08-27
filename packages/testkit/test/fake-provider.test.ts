import { describe, expect, it } from "vitest";
import { ProviderError } from "@openmetal/provider-core";
import { collectExecEvents, exerciseSandboxProvider, FakeSandboxProvider } from "../src/index.js";

const input = {
  metalSandboxId: "sbx_test",
  organizationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  language: "typescript",
  ttlMinutes: 30,
  source: { kind: "environment" as const, environment: "metal/node", version: "1" },
  resources: {
    vcpu: 1,
    memoryMb: 512,
    architecture: "x86_64" as const,
  },
  lifecycle: {
    runtimeTimeoutSeconds: 1800,
    onRuntimeTimeout: "destroy" as const,
    onIdleTimeout: "destroy" as const,
  },
};

describe("fake sandbox provider", () => {
  it("passes lifecycle conformance and double destroy", async () => {
    const provider = new FakeSandboxProvider();
    const result = await exerciseSandboxProvider(provider, input);
    expect(result.created.providerResourceId).toBe("fake-sbx_test");
    expect(result.cost?.amountMicrousd).toBeGreaterThan(0n);
    expect(result.runtime?.execEvents?.map((event) => event.type)).toEqual([
      "stdout",
      "stderr",
      "exit",
    ]);
    expect(result.runtime?.cancellationEvents?.at(-1)).toMatchObject({
      type: "exit",
      cancelled: true,
    });
    expect(result.runtime?.listedPaths).toEqual([
      "/tmp/metal-conformance.bin",
      "/tmp/metal-conformance.txt",
    ]);
    expect(result.runtime?.endpointUrl).toBe("https://fake-sbx_test.fake.invalid:3000/health");
    expect(provider.resources.size).toBe(0);
    expect(provider.files.size).toBe(0);
    expect(provider.endpointLeases.size).toBe(0);
  });

  it("reconciles an unknown create without duplicating", async () => {
    const provider = new FakeSandboxProvider("e2b", {
      failures: [{ kind: "unknown_outcome", retryable: true }],
      unknownCreatesResource: true,
    });
    await expect(provider.create(input)).rejects.toThrow();
    const reconciled = await provider.reconcileCreate(input.metalSandboxId);
    expect(reconciled?.providerResourceId).toBe("fake-sbx_test");
    expect(provider.resources.size).toBe(1);
  });

  it("orders and bounds stdout, stderr, and exit events", async () => {
    const provider = new FakeSandboxProvider("e2b", {
      runtimeLimits: { maxOutputBytes: 4 },
      exec: {
        output: [
          { type: "stdout", data: "abc" },
          { type: "stderr", data: "def" },
        ],
        exitCode: 7,
      },
    });
    const sandbox = await provider.create(input);
    const execution = await provider.exec({
      providerResourceId: sandbox.providerResourceId,
      command: ["ignored"],
    });
    const events = await collectExecEvents(execution.events);

    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [0, "stdout"],
      [1, "stderr"],
      [2, "exit"],
    ]);
    expect(events[0]).toMatchObject({ data: Uint8Array.from([97, 98, 99]) });
    expect(events[1]).toMatchObject({ data: Uint8Array.from([100]), truncated: true });
    expect(events[2]).toMatchObject({
      exitCode: 7,
      cancelled: false,
      outputTruncated: true,
    });
  });

  it("cancels an active non-interactive execution", async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(input);
    const execution = await provider.exec({
      providerResourceId: sandbox.providerResourceId,
      command: ["ignored"],
    });
    const iterator = execution.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ sequence: 0, type: "stdout" });
    await expect(
      provider.cancelExec({
        providerResourceId: sandbox.providerResourceId,
        executionId: execution.executionId,
      }),
    ).resolves.toEqual({ executionId: execution.executionId, cancelled: true });
    expect((await iterator.next()).value).toMatchObject({
      sequence: 1,
      type: "exit",
      exitCode: null,
      cancelled: true,
    });
  });

  it("round-trips text and binary files, lists, truncates, and deletes", async () => {
    const provider = new FakeSandboxProvider("e2b", {
      runtimeLimits: { maxReadBytes: 3, maxWriteBytes: 8, maxListEntries: 1 },
    });
    const sandbox = await provider.create(input);
    const providerResourceId = sandbox.providerResourceId;
    await provider.writeFile({ providerResourceId, path: "/tmp/a.txt", data: "hello" });
    await provider.writeFile({
      providerResourceId,
      path: "/tmp/b.bin",
      data: Uint8Array.from([0, 128, 255]),
    });

    await expect(
      provider.readFile({
        providerResourceId,
        path: "/tmp/a.txt",
        encoding: "utf8",
      }),
    ).resolves.toMatchObject({ data: "hel", sizeBytes: 5, truncated: true });
    await expect(
      provider.readFile({
        providerResourceId,
        path: "/tmp/b.bin",
        encoding: "binary",
      }),
    ).resolves.toMatchObject({
      data: Uint8Array.from([0, 128, 255]),
      sizeBytes: 3,
      truncated: false,
    });
    await expect(provider.listFiles({ providerResourceId, path: "/tmp" })).resolves.toEqual({
      entries: [{ path: "/tmp/a.txt", type: "file", sizeBytes: 5, modifiedAt: null }],
      truncated: true,
    });
    await expect(provider.deleteFile({ providerResourceId, path: "/tmp/a.txt" })).resolves.toEqual({
      path: "/tmp/a.txt",
      deleted: true,
    });
    await expect(provider.deleteFile({ providerResourceId, path: "/tmp/a.txt" })).resolves.toEqual({
      path: "/tmp/a.txt",
      deleted: false,
    });
    await expect(
      provider.writeFile({ providerResourceId, path: "/tmp/large", data: "123456789" }),
    ).rejects.toMatchObject({ kind: "invalid_request", retryable: false });
  });

  it("leases and idempotently revokes normalized HTTP endpoints", async () => {
    const provider = new FakeSandboxProvider("e2b", {
      runtimeLimits: { maxLeaseDurationSeconds: 60 },
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    const sandbox = await provider.create(input);
    const providerResourceId = sandbox.providerResourceId;
    const lease = await provider.exposeHttpEndpoint({
      providerResourceId,
      port: 8_080,
      path: "ready",
      leaseDurationSeconds: 30,
    });

    expect(lease).toEqual({
      leaseId: "fake-lease-1",
      url: "https://fake-sbx_test.fake.invalid:8080/ready",
      expiresAt: new Date("2030-01-01T00:00:30.000Z"),
    });
    await expect(
      provider.revokeHttpEndpoint({ providerResourceId, leaseId: lease.leaseId }),
    ).resolves.toEqual({ leaseId: lease.leaseId, revoked: true });
    await expect(
      provider.revokeHttpEndpoint({ providerResourceId, leaseId: lease.leaseId }),
    ).resolves.toEqual({ leaseId: lease.leaseId, revoked: false });
    await expect(
      provider.exposeHttpEndpoint({
        providerResourceId,
        port: 8_080,
        leaseDurationSeconds: 61,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("normalizes dropped streams and unsupported runtime capabilities", async () => {
    const dropped = new FakeSandboxProvider("e2b", {
      exec: { dropStreamAfterEvents: 1 },
    });
    const droppedSandbox = await dropped.create(input);
    const execution = await dropped.exec({
      providerResourceId: droppedSandbox.providerResourceId,
      command: ["ignored"],
    });
    const iterator = execution.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ sequence: 0, type: "stdout" });
    await expect(iterator.next()).rejects.toMatchObject({
      kind: "unknown_outcome",
      retryable: true,
    });

    const unsupported = new FakeSandboxProvider("e2b", {
      unsupportedRuntimeOperations: ["exec", "deleteFile"],
    });
    const unsupportedSandbox = await unsupported.create(input);
    expect(unsupported.capabilities.runtime?.process?.exec).toBe(false);
    expect(unsupported.capabilities.runtime?.files?.delete).toBe(false);
    await expect(
      unsupported.exec({
        providerResourceId: unsupportedSandbox.providerResourceId,
        command: ["ignored"],
      }),
    ).rejects.toMatchObject({ kind: "unsupported", retryable: false });
  });

  it("honors AbortSignal and expired deadlines", async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(input);
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.exec({
        providerResourceId: sandbox.providerResourceId,
        command: ["ignored"],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      provider.listFiles({
        providerResourceId: sandbox.providerResourceId,
        path: "/tmp",
        deadline: new Date(0),
      }),
    ).rejects.toMatchObject({ kind: "timeout_absent", retryable: true });
  });
});
