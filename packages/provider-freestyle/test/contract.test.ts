import { expect, it, vi } from "vitest";
import type { ProviderExecEvent } from "@openmetal/provider-core";
import { FreestyleSandboxProvider } from "../src/index.js";

const MIB = 1_024 * 1_024;

it("declares the Freestyle baseline contract", () => {
  const provider = makeProvider(vi.fn());

  expect(provider.name).toBe("freestyle");
  expect(provider.capabilities).toEqual({
    pause: true,
    resume: true,
    cost: true,
    sizing: "template",
    sources: ["environment", "provider_template"],
    runtime: {
      process: {
        exec: true,
        streams: false,
        cancel: false,
        maxOutputBytes: 10 * MIB,
      },
      files: {
        read: true,
        write: true,
        writeModes: ["overwrite"],
        createParents: true,
        list: true,
        delete: true,
        maxReadBytes: 10 * MIB,
        maxWriteBytes: 10 * MIB,
        maxListEntries: 10_000,
      },
      httpEndpoints: { expose: false, revoke: false },
    },
  });
  expect(provider.cancelExec).toBeUndefined();
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
});

it("creates from a provider template, tags the VM, waits, and only grows resources", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
    const value = String(path);
    requests.push({ path: value, init });
    if (value === "/v5/vms" && init?.method === "POST") {
      return jsonResponse(vm({ state: "starting" }));
    }
    if (value === "/v5/vms/vm-1" && init?.method === "GET") {
      return jsonResponse(vm());
    }
    if (value === "/v5/vms/vm-1/resize") {
      expect(JSON.parse(String(init?.body))).toEqual({
        cpu: 4,
        memory: 8_192,
        storage: 32_768,
      });
      return jsonResponse(vm({ resources: { cpu: 4, memory: 8_192, storage: 32_768 } }));
    }
    throw new Error(`unexpected request: ${value}`);
  });
  const provider = makeProvider(fetchImpl);

  const created = await provider.create(createInput());

  const body = JSON.parse(String(requests[0]?.init?.body)) as {
    snapshotId: string;
    slug: string;
    reassignSlug?: boolean;
    metadata: Record<string, string>;
    firewall: unknown;
    ttlSeconds: number;
    maxRunSeconds?: number;
    idleTimeoutSeconds?: number;
  };
  expect(body.snapshotId).toBe("team/custom-snapshot");
  expect(body.slug).toMatch(/^metal-[a-z0-9-]+-[a-f0-9]{10}$/);
  expect(body.slug.length).toBeLessThanOrEqual(63);
  expect(body.reassignSlug).toBeUndefined();
  expect(body.metadata).toMatchObject({
    "metal.sandbox_id": "sbx-1",
    "metal.organization_id": "org-1",
    "metal.project_id": "project-1",
  });
  expect(body.firewall).toEqual({
    rules: [{ action: "allow", source: {}, destination: { public: true } }],
  });
  expect(body.ttlSeconds).toBe(3_600);
  expect(body.maxRunSeconds).toBe(900);
  expect(body.idleTimeoutSeconds).toBe(120);
  expect(created).toMatchObject({
    providerResourceId: "vm-1",
    providerOrganizationId: "account-1",
    resolvedResources: {
      vcpu: 4,
      memoryMb: 8_192,
      diskMb: 32_768,
      architecture: "x86_64",
      providerSize: "team/custom-snapshot",
    },
  });
});

it("deletes a known VM when post-create setup fails", async () => {
  const requests: string[] = [];
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const value = String(path);
      requests.push(`${init?.method ?? "GET"} ${value}`);
      if (value === "/v5/vms" && init?.method === "POST") {
        return jsonResponse(vm());
      }
      if (value === "/v5/vms/vm-1" && init?.method === "GET") {
        return jsonResponse(vm());
      }
      if (value === "/v5/vms/vm-1/resize") {
        return jsonResponse({ code: "RESIZE_FAILED", message: "resize failed" }, { status: 503 });
      }
      if (value === "/v5/vms/vm-1" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${value}`);
    }),
  );

  await expect(provider.create(createInput())).rejects.toMatchObject({
    kind: "unavailable",
    retryable: true,
  });
  expect(requests).toContain("DELETE /v5/vms/vm-1");
});

it("omits lifecycle controls whose Freestyle action does not match", async () => {
  let createBody: Record<string, unknown> | undefined;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/v5/vms") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(vm());
      }
      if (String(path) === "/v5/vms/vm-1") return jsonResponse(vm());
      throw new Error(`unexpected request: ${String(path)}`);
    }),
  );
  const input = createInput();
  input.lifecycle.onRuntimeTimeout = "destroy";
  input.lifecycle.onIdleTimeout = "destroy";
  input.resources = {
    vcpu: 2,
    memoryMb: 4_096,
    diskMb: 16_384,
    architecture: "x86_64",
  };

  await provider.create({
    ...input,
    source: { kind: "environment", environment: "metal/base" },
  });

  expect(createBody).toHaveProperty("snapshotId", "freestyle/ubuntu-sm");
  expect(createBody).not.toHaveProperty("maxRunSeconds");
  expect(createBody).not.toHaveProperty("idleTimeoutSeconds");
});

it("uses a Freestyle snapshot provider option for portable environments", async () => {
  let snapshotId: unknown;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/v5/vms") {
        snapshotId = (JSON.parse(String(init?.body)) as { snapshotId?: unknown }).snapshotId;
        return jsonResponse(vm());
      }
      if (String(path) === "/v5/vms/vm-1") return jsonResponse(vm());
      throw new Error(`unexpected request: ${String(path)}`);
    }),
  );
  const input = createInput();
  input.source = {
    kind: "environment",
    environment: "metal/node",
    version: "latest",
  };
  input.providerOptions = { snapshot_id: "team/node-22" };
  input.resources = {
    vcpu: 2,
    memoryMb: 4_096,
    diskMb: 16_384,
    architecture: "x86_64",
  };

  await provider.create(input);

  expect(snapshotId).toBe("team/node-22");
});

it("reconciles a duplicate create by deterministic slug and metadata", async () => {
  let slug = "";
  let createCalls = 0;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const value = String(path);
      if (value === "/v5/vms") {
        createCalls += 1;
        slug = (JSON.parse(String(init?.body)) as { slug: string }).slug;
        return jsonResponse({ code: "SLUG_ALREADY_EXISTS", message: "duplicate" }, { status: 409 });
      }
      if (value.startsWith("/v5/vms?slug=")) {
        return jsonResponse(listResult([vm({ slug })]));
      }
      if (value === "/v5/vms/vm-1") return jsonResponse(vm({ slug }));
      throw new Error(`unexpected request: ${value}`);
    }),
  );

  const input = createInput();
  input.resources = {
    vcpu: 2,
    memoryMb: 4_096,
    diskMb: 16_384,
    architecture: "x86_64",
  };
  await expect(provider.create(input)).resolves.toMatchObject({
    providerResourceId: "vm-1",
  });
  await expect(provider.reconcileCreate("sbx-1")).resolves.toMatchObject({
    providerResourceId: "vm-1",
  });
  expect(createCalls).toBe(1);
});

it("reconciles an unknown transport outcome without reassigning the slug", async () => {
  let slug = "";
  let createAttempted = false;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const value = String(path);
      if (value === "/v5/vms") {
        createAttempted = true;
        slug = (JSON.parse(String(init?.body)) as { slug: string }).slug;
        throw new TypeError("connection reset");
      }
      if (value.startsWith("/v5/vms?slug=")) {
        return jsonResponse(listResult([vm({ slug })]));
      }
      if (value === "/v5/vms/vm-1") return jsonResponse(vm({ slug }));
      throw new Error(`unexpected request: ${value}`);
    }),
  );
  const input = createInput();
  input.resources = {
    vcpu: 2,
    memoryMb: 4_096,
    diskMb: 16_384,
    architecture: "x86_64",
  };

  await expect(provider.create(input)).resolves.toMatchObject({
    providerResourceId: "vm-1",
  });
  expect(createAttempted).toBe(true);
});

it("captures final usage before idempotent deletion", async () => {
  let deleted = false;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/v5/vms/vm-1" && init?.method === "GET") {
        return deleted
          ? jsonResponse({ code: "NOT_FOUND", message: "gone" }, { status: 404 })
          : jsonResponse(vm({ totalRunSeconds: 3_600 }));
      }
      if (String(path) === "/v5/vms/vm-1" && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${String(path)}`);
    }),
  );

  const result = await provider.destroy("vm-1");
  expect(result.providerMetadata).toMatchObject({
    freestyle: {
      createdAt: "2026-09-10T10:00:00.000Z",
      destroyedAt: expect.any(String),
      totalRunSeconds: 3_600,
      resources: { cpu: 2, memory: 4_096, storage: 16_384 },
    },
  });
  await expect(provider.destroy("vm-1")).resolves.toEqual({});
});

it("pauses state-aware and resumes with start plus readiness", async () => {
  const requests: string[] = [];
  let state: "running" | "paused" = "paused";
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const value = String(path);
      requests.push(`${init?.method ?? "GET"} ${value}`);
      if (value === "/v5/vms/vm-1" && init?.method === "GET") {
        return jsonResponse(vm({ state }));
      }
      if (value === "/v5/vms/vm-1/start") {
        state = "running";
        return jsonResponse(vm({ state }));
      }
      if (value === "/v5/vms/vm-1/pause") {
        state = "paused";
        return jsonResponse(vm({ state }));
      }
      throw new Error(`unexpected request: ${value}`);
    }),
  );

  await provider.pause("vm-1");
  expect(requests).toEqual(["GET /v5/vms/vm-1"]);
  const resumed = await provider.resume("vm-1");
  expect(requests).toContain("POST /v5/vms/vm-1/start");
  expect(resumed.providerResourceId).toBe("vm-1");
  await provider.pause("vm-1");
  expect(requests).toContain("POST /v5/vms/vm-1/pause");
});

it("executes exact argv with native env/stdin and separates nonzero buffered output", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      expect(String(path)).toBe("/v5/vms/vm-1/exec-await");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ stdout: "hello", stderr: "warning", statusCode: 7 });
    }),
  );

  const result = await provider.exec({
    providerResourceId: "vm-1",
    command: ["printf", "%s", "a'b"],
    cwd: "/tmp/a b",
    environment: { MESSAGE: "hello world" },
    stdin: Uint8Array.from([0, 255]),
    maxOutputBytes: 8,
  });
  const events = await collect(result.events);

  expect(body).toEqual({
    command: `cd -- '/tmp/a b' && 'printf' '%s' 'a'"'"'b'`,
    timeoutMs: 300_000,
    env: { MESSAGE: "hello world" },
    stdin: "AP8=",
  });
  expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(decode(events[0])).toBe("hello");
  expect(decode(events[1])).toBe("war");
  expect(events[1]).toMatchObject({ truncated: true });
  expect(events[2]).toMatchObject({
    exitCode: 7,
    signal: null,
    cancelled: false,
    outputTruncated: true,
  });
});

it("does not treat a null Freestyle statusCode as success", async () => {
  const provider = makeProvider(
    vi.fn().mockResolvedValue(jsonResponse({ stdout: "", stderr: "", statusCode: null })),
  );
  const execution = await provider.exec({
    providerResourceId: "vm-1",
    command: ["sleep", "999"],
  });

  await expect(collect(execution.events)).resolves.toEqual([
    {
      type: "exit",
      sequence: 0,
      exitCode: null,
      signal: "UNKNOWN",
      cancelled: false,
      outputTruncated: false,
    },
  ]);
});

it("rejects unsupported write modes and all declared limits", async () => {
  const fetchImpl = vi.fn();
  const provider = makeProvider(fetchImpl);

  await expect(
    provider.writeFile({
      providerResourceId: "vm-1",
      path: "/tmp/x",
      data: "x",
      mode: "create",
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.writeFile({
      providerResourceId: "vm-1",
      path: "/tmp/x",
      data: "x",
      mode: "append",
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.writeFile({
      providerResourceId: "vm-1",
      path: "/tmp/x",
      data: new Uint8Array(10 * MIB + 1),
    }),
  ).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(
    provider.readFile({
      providerResourceId: "vm-1",
      path: "/tmp/x",
      maxBytes: 10 * MIB + 1,
    }),
  ).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(
    provider.listFiles({
      providerResourceId: "vm-1",
      path: "/tmp",
      maxEntries: 10_001,
    }),
  ).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(
    provider.exec({
      providerResourceId: "vm-1",
      command: ["cat"],
      stdin: new Uint8Array(MIB + 1),
    }),
  ).rejects.toMatchObject({ kind: "invalid_request" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("performs native binary ranged reads", async () => {
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const value = String(path);
      if (value.includes("/fs/stat?")) return jsonResponse(fileStat({ size: 5 }));
      if (value.includes("/fs/read?")) {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
        return new Response(Uint8Array.from([1, 2]), { status: 206 });
      }
      throw new Error(`unexpected request: ${value}`);
    }),
  );

  await expect(
    provider.readFile({
      providerResourceId: "vm-1",
      path: "/tmp/data.bin",
      offsetBytes: 1,
      maxBytes: 2,
    }),
  ).resolves.toMatchObject({
    data: Uint8Array.from([1, 2]),
    offsetBytes: 1,
    byteLength: 2,
    sizeBytes: 5,
    eof: false,
    truncated: true,
  });
});

it("writes atomically, recursively lists, and idempotently deletes trees", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let existsCalls = 0;
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const value = String(path);
      requests.push({ path: value, init });
      if (value.includes("/fs/exists?")) {
        existsCalls += 1;
        return jsonResponse({ exists: existsCalls === 2 });
      }
      if (value.includes("/fs/mkdir")) return new Response(null, { status: 204 });
      if (value.includes("/fs/write?")) return new Response(null, { status: 204 });
      if (value.includes("/fs/dir?") && value.endsWith("path=%2Froot")) {
        return jsonResponse({
          entries: [
            { name: "a.bin", kind: "file" },
            { name: "nested", kind: "directory" },
          ],
        });
      }
      if (value.includes("/fs/dir?") && value.endsWith("path=%2Froot%2Fnested")) {
        return jsonResponse({ entries: [] });
      }
      if (value.includes("/fs/stat?path=%2Froot%2Fa.bin")) {
        return jsonResponse(fileStat({ size: 2 }));
      }
      if (value.includes("/fs/stat?path=%2Froot%2Fnested")) {
        return jsonResponse(fileStat({ isFile: false, isDirectory: true, size: 0 }));
      }
      if (value.includes("/fs/stat?path=%2Froot")) {
        return jsonResponse(fileStat({ isFile: false, isDirectory: true, size: 0 }));
      }
      if (value.includes("/fs/remove?")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request: ${value}`);
    }),
  );

  await expect(
    provider.writeFile({
      providerResourceId: "vm-1",
      path: "/root/data.bin",
      data: Uint8Array.from([8, 9]),
      createParents: true,
    }),
  ).resolves.toEqual({ path: "/root/data.bin", bytesWritten: 2, created: true });
  const writeRequest = requests.find((request) => request.path.includes("/fs/write?"));
  expect(writeRequest?.path).toContain(
    "sha256=73907589101a7e8ab83178e7db2997aab7272cd02d364e8e3ecc2beccda4b631",
  );
  expect(writeRequest?.init?.body).toEqual(Uint8Array.from([8, 9]));

  await expect(
    provider.listFiles({
      providerResourceId: "vm-1",
      path: "/root",
      recursive: true,
    }),
  ).resolves.toMatchObject({
    entries: [
      { path: "/root/a.bin", type: "file", sizeBytes: 2 },
      { path: "/root/nested", type: "directory", sizeBytes: null },
    ],
    truncated: false,
  });
  await expect(
    provider.deleteFile({
      providerResourceId: "vm-1",
      path: "/root",
      recursive: true,
    }),
  ).resolves.toEqual({ path: "/root", deleted: true });
  await expect(
    provider.deleteFile({
      providerResourceId: "vm-1",
      path: "/root",
      recursive: true,
    }),
  ).resolves.toEqual({ path: "/root", deleted: false });
});

it("rejects nonrecursive deletion of a nonempty directory", async () => {
  const provider = makeProvider(
    vi.fn(async (path: string | URL | Request) => {
      const value = String(path);
      if (value.includes("/fs/exists?")) return jsonResponse({ exists: true });
      if (value.includes("/fs/stat?")) {
        return jsonResponse(fileStat({ isFile: false, isDirectory: true }));
      }
      if (value.includes("/fs/dir?")) {
        return jsonResponse({ entries: [{ name: "child", kind: "file" }] });
      }
      throw new Error(`unexpected request: ${value}`);
    }),
  );

  await expect(
    provider.deleteFile({
      providerResourceId: "vm-1",
      path: "/root",
      recursive: false,
    }),
  ).rejects.toMatchObject({ kind: "customer" });
});

it("calculates exact cumulative gross cost with integer rate-card arithmetic", async () => {
  const provider = makeProvider(
    vi.fn().mockResolvedValue(jsonResponse(vm({ totalRunSeconds: 3_600 }))),
  );

  const cost = await provider.getCost({
    providerResourceId: "vm-1",
    providerOrganizationId: "account-1",
    from: new Date("2026-09-10T10:30:00.000Z"),
    to: new Date("2026-09-10T11:00:00.000Z"),
  });

  expect(cost).toMatchObject({
    amountMicrousd: 133_616n,
    providerOrganizationId: "account-1",
    measuredThrough: new Date("2026-09-10T11:00:00.000Z"),
    provenance: "estimated_rate_card",
    confidence: "low",
    source: "freestyle-current-vm-rate-card",
    rateCardVersion: "2026-09-10",
    raw: {
      cumulative: true,
      excludes: ["transfer", "plan_credits", "discounts"],
      totalRunSeconds: 3_600,
      storageSeconds: 3_600,
    },
  });
});

it("uses final destroy metadata for the same exact cumulative cost", async () => {
  const provider = makeProvider(
    vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: "NOT_FOUND", message: "gone" }, { status: 404 })),
  );
  const providerMetadata = {
    freestyle: {
      createdAt: "2026-09-10T10:00:00.000Z",
      destroyedAt: "2026-09-10T11:00:00.000Z",
      totalRunSeconds: 3_600,
      resources: { cpu: 2, memory: 4_096, storage: 16_384 },
    },
  };

  const cost = await provider.getCost({
    providerResourceId: "vm-1",
    providerMetadata,
    from: new Date("2026-09-10T10:00:00.000Z"),
    to: new Date("2026-09-11T11:00:00.000Z"),
  });

  expect(cost).toMatchObject({
    amountMicrousd: 133_616n,
    measuredThrough: new Date("2026-09-10T11:00:00.000Z"),
    source: "freestyle-destroy-metadata-rate-card",
    raw: { usageSource: "destroy_metadata", storageSeconds: 3_600 },
  });
});

it.each([
  [401, "BAD_TOKEN", "auth", false],
  [429, "QUOTA_EXCEEDED", "quota", true],
  [409, "NO_HOST_CAPACITY", "capacity", true],
  [503, "UNAVAILABLE", "unavailable", true],
] as const)("classifies Freestyle %s/%s as %s", async (status, code, kind, retryable) => {
  const provider = makeProvider(
    vi.fn().mockResolvedValue(jsonResponse({ code, message: "classified" }, { status })),
  );

  await expect(provider.pause("vm-1")).rejects.toMatchObject({ kind, retryable });
});

it("classifies transport timeouts by operation outcome", async () => {
  const timeout = new DOMException("timed out", "TimeoutError");
  const provider = makeProvider(vi.fn().mockRejectedValue(timeout));

  await expect(provider.reconcileCreate("sbx-1")).rejects.toMatchObject({
    kind: "timeout_absent",
    retryable: true,
  });
  await expect(provider.create(createInput())).rejects.toMatchObject({
    kind: "unknown_outcome",
    retryable: true,
  });
});

function makeProvider(fetchImpl: typeof fetch | ReturnType<typeof vi.fn>) {
  return new FreestyleSandboxProvider({
    apiKey: "test",
    accountId: "account-1",
    client: { fetch: fetchImpl as typeof fetch },
  });
}

function createInput() {
  return {
    metalSandboxId: "sbx-1",
    organizationId: "org-1",
    projectId: "project-1",
    language: "typescript",
    ttlMinutes: 60,
    source: {
      kind: "provider_template" as const,
      template: "team/custom-snapshot",
    },
    resources: {
      vcpu: 4,
      memoryMb: 8_192,
      diskMb: 32_768,
      architecture: "x86_64" as const,
    },
    lifecycle: {
      runtimeTimeoutSeconds: 900,
      idleTimeoutSeconds: 120,
      onRuntimeTimeout: "pause" as const,
      onIdleTimeout: "pause" as const,
    },
  };
}

function vm(overrides: Record<string, unknown> = {}) {
  return {
    id: "vm-1",
    state: "running",
    slug: "metal-sbx-1-placeholder",
    resources: { cpu: 2, memory: 4_096, storage: 16_384 },
    snapshotId: "sh-1",
    sourceSnapshotSlugAtCreate: "team/custom-snapshot",
    metadata: {
      "metal.sandbox_id": "sbx-1",
      "metal.organization_id": "org-1",
      "metal.project_id": "project-1",
    },
    vpcs: [],
    networks: [],
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
    totalRunSeconds: 0,
    ...overrides,
  };
}

function listResult(vms: unknown[]) {
  return {
    vms,
    totalCount: vms.length,
    runningCount: vms.length,
    startingCount: 0,
    pausingCount: 0,
    pausedCount: 0,
    stoppedCount: 0,
  };
}

function fileStat(overrides: Record<string, unknown> = {}) {
  return {
    size: 1,
    isFile: true,
    isDirectory: false,
    isSymlink: false,
    permissions: "0644",
    owner: "root",
    group: "root",
    modified: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

async function collect(events: AsyncIterable<ProviderExecEvent>): Promise<ProviderExecEvent[]> {
  const result: ProviderExecEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function decode(event: ProviderExecEvent | undefined): string | undefined {
  return event?.type === "stdout" || event?.type === "stderr"
    ? new TextDecoder().decode(event.data)
    : undefined;
}
