import { expect, it, vi } from "vitest";
import { PrimeSandboxProvider } from "../src/index.js";
import { connectEnvelope, startCommandSession } from "../src/command-session.js";
import type { ProviderCreateSandboxInput } from "@openmetal/provider-core";

const sandbox = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "sbx_prime",
  name: "metal-test",
  status,
  dockerImage: "node:22",
  vm: true,
  cpuCores: 2,
  memoryGB: 4,
  diskSizeGB: 5,
  createdAt: "2026-09-25T00:00:00Z",
  startedAt: "2026-09-25T00:00:00Z",
  labels: [],
  userId: "user-1",
  ...extra,
});
const snakeSandbox = (status: string) => ({
  id: "sbx_prime",
  name: "metal-test",
  status,
  docker_image: "node:22",
  vm: true,
  cpu_cores: 2,
  memory_gb: 4,
  disk_size_gb: 5,
  created_at: "2026-09-25T00:00:00Z",
  started_at: "2026-09-25T00:00:00Z",
  labels: [],
  user_id: "user-1",
});
const input = (): ProviderCreateSandboxInput => ({
  metalSandboxId: "sbx_metal_1",
  organizationId: "org-1",
  projectId: "project-1",
  language: "typescript",
  ttlMinutes: 60,
  source: { kind: "environment", environment: "metal/node" },
  resources: { vcpu: 1.5, memoryMb: 4000, architecture: "any" },
  lifecycle: { runtimeTimeoutSeconds: 3600, onRuntimeTimeout: "destroy", onIdleTimeout: "destroy" },
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const auth = {
  gateway_url: "https://gateway.example",
  user_ns: "user",
  job_id: "job",
  token: "gateway-token",
};

it("encodes a command request compatible with Prime's published protobuf schema", () => {
  // Fixture generated with prime_sandboxes._proto.command_session.command_session_pb2.
  expect(
    Buffer.from(
      startCommandSession(
        ["sh", "-c", "echo hi"],
        "/workspace",
        {
          LANG: "C",
        },
        "some-session",
      ),
    ).toString("base64"),
  ).toBe(
    "CkAKCS9iaW4vYmFzaBICLWMSGGV4ZWMgJ3NoJyAnLWMnICdlY2hvIGhpJxoJCgRMQU5HEgFDIgovd29ya3NwYWNlKgxzb21lLXNlc3Npb24=",
  );
});

it("declares only supported Prime VM capabilities", () => {
  const provider = new PrimeSandboxProvider({ apiKey: "test" });
  expect(provider.capabilities).toMatchObject({
    pause: false,
    cost: true,
    sizing: "direct",
    runtime: {
      process: { exec: true, streams: false, cancel: false },
      files: { read: true, write: true, list: false, delete: false, writeModes: ["overwrite"] },
      httpEndpoints: { expose: false },
    },
  });
});

it("reuses a stable create key, resolves Prime sizing, waits and destroys twice", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).includes("/sandbox?") && init?.method === "GET") {
      return json({ sandboxes: [], has_next: false });
    }
    if (String(url).endsWith("/sandbox") && init?.method === "POST") {
      return json(snakeSandbox("PROVISIONING"));
    }
    if (String(url).endsWith("/sandbox/sbx_prime") && init?.method === "GET") {
      return json(snakeSandbox("RUNNING"));
    }
    if (init?.method === "DELETE") return json({ deleted: true });
    throw Error(`unexpected ${init?.method} ${url}`);
  });
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  const created = await provider.create(input());
  const post = calls.find((call) => call.init.method === "POST")!;
  const payload = JSON.parse(post.init.body as string);
  expect(payload).toMatchObject({
    docker_image: "node:22",
    vm: true,
    cpu_cores: 2,
    memory_gb: 4,
    disk_size_gb: 5,
    timeout_minutes: 60,
  });
  expect(payload.idempotency_key).toMatch(/^[a-f0-9]{64}$/);
  expect(payload.labels).toContain("metal-project-project-1");
  expect(created).toMatchObject({
    providerResourceId: "sbx_prime",
    providerOrganizationId: "user-1",
    resolvedResources: { vcpu: 2, memoryMb: 4096, diskMb: 5120 },
  });
  expect((await provider.destroy("sbx_prime")).providerMetadata?.prime).toMatchObject({
    terminatedAt: expect.any(String),
  });
  await provider.destroy("sbx_prime");
  expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(2);
});

it("treats timezone-less Prime timestamps as UTC and reports the provisioned disk", async () => {
  const actual = {
    ...snakeSandbox("RUNNING"),
    created_at: "2026-09-25T09:43:12.345000",
    started_at: "2026-09-25T09:43:14.118000",
    disk_size_gb: 32,
  };
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("/sandbox?")
        ? json({ sandboxes: [], has_next: false })
        : init?.method === "POST" || init?.method === "GET"
          ? json(actual)
          : json({}, 404)) as typeof fetch,
  });
  const created = await provider.create(input());
  expect(created.resolvedResources?.diskMb).toBe(32 * 1024);
  expect((created.providerMetadata?.prime as { startedAt: string }).startedAt).toBe(
    "2026-09-25T09:43:14.118000Z",
  );
  const cost = await provider.getCost({
    providerResourceId: created.providerResourceId,
    from: new Date("2026-09-25T09:43:14Z"),
    to: new Date("2026-09-25T09:43:20Z"),
  });
  expect(cost?.amountMicrousd).toBe(134n);
});

it("recovers ambiguous creates by label and refuses unsupported requirements before POST", async () => {
  let label = "";
  let posts = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++;
      throw Error("lost response");
    }
    const query = new URL(String(url)).searchParams;
    label = query.get("labels") ?? label;
    return json({
      sandboxes: posts ? [sandbox("RUNNING", { labels: [label] })] : [],
      has_next: false,
    });
  });
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  await expect(provider.create(input())).rejects.toMatchObject({ kind: "unknown_outcome" });
  expect((await provider.reconcileCreate(input().metalSandboxId))?.providerResourceId).toBe(
    "sbx_prime",
  );
  expect((await provider.create(input())).providerResourceId).toBe("sbx_prime");
  expect(posts).toBe(1);
  await expect(
    provider.create({ ...input(), resources: { ...input().resources, architecture: "arm64" } }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.create({ ...input(), secretRefs: { PASSWORD: "secret_ref" } }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.create({ ...input(), network: { allow_domains: ["example.com"] } }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.create({ ...input(), features: { public_ports: [3000] } }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.create({
      ...input(),
      source: { kind: "provider_template", template: "docker.io/node:22" },
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  expect(posts).toBe(1);
});

it("deletes a known failed VM and keeps an unconfirmed cleanup in reconciliation", async () => {
  let deletions = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/sandbox?") && init?.method === "GET") {
      return json({ sandboxes: [], has_next: false });
    }
    if (init?.method === "POST") return json(sandbox("ERROR"));
    if (init?.method === "GET") return json(sandbox("ERROR"));
    if (init?.method === "DELETE") {
      deletions++;
      return json({ deleted: true });
    }
    throw Error("unexpected request");
  });
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  await expect(provider.create(input())).rejects.toMatchObject({ kind: "unavailable" });
  expect(deletions).toBe(1);

  fetchImpl.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/sandbox?")) {
      return json({
        sandboxes: [
          sandbox("ERROR", { labels: [new URL(String(url)).searchParams.get("labels")] }),
        ],
        has_next: false,
      });
    }
    if (init?.method === "GET") return json(sandbox("ERROR"));
    throw Error("delete response lost");
  });
  await expect(provider.reconcileCreate(input().metalSandboxId)).rejects.toMatchObject({
    kind: "unavailable",
  });
});

it.each([
  ["HTTP 503", () => json({ detail: "retry" }, 503)],
  ["incomplete response", () => json({ accepted: true })],
] as const)("keeps an uncertain %s create out of fallback", async (_name, reply) => {
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: (async (url: string | URL | Request) =>
      String(url).includes("/sandbox?")
        ? json({ sandboxes: [], has_next: false })
        : reply()) as typeof fetch,
  });
  await expect(provider.create(input())).rejects.toMatchObject({ kind: "unknown_outcome" });
});

it("parses Prime protobuf command frames into ordered output and a nonzero exit", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init! });
    if (String(url).endsWith("/auth")) return json(auth);
    const frames = ["CgkSBwoFaGVsbG8=", "CggSBhIEb29wcw==", "CgYaBAgOEAE="].map((base64) =>
      connectEnvelope(Uint8Array.from(Buffer.from(base64, "base64"))),
    );
    const trailer = connectEnvelope(new TextEncoder().encode("{}"));
    trailer[0] = 2;
    return new Response(new Blob([...frames, trailer]).stream());
  });
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  const process = await provider.exec({
    providerResourceId: "sbx_prime",
    command: ["sh", "-c", "echo hi"],
    maxOutputBytes: 7,
  });
  const events = [];
  for await (const event of process.events) events.push(event);
  expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(events[0]).toMatchObject({ data: new TextEncoder().encode("hello") });
  expect(events[1]).toMatchObject({ data: new TextEncoder().encode("oo") });
  expect(events[2]).toMatchObject({ exitCode: 7, outputTruncated: true });
  expect(sent[1]?.url).toBe(
    "https://gateway.example/user/job/command_session.CommandSession/Start",
  );
  expect(sent[1]?.init.headers).toMatchObject({
    authorization: "Bearer gateway-token",
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
  });
  await expect(
    provider.exec({ providerResourceId: "sbx_prime", command: ["echo"], stdin: "x" }),
  ).rejects.toMatchObject({ kind: "unsupported" });
});

it("transfers binary files with a bounded read and reports rate-card cost exactly", async () => {
  const bytes = Uint8Array.from([0, 1, 255, 2]);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).endsWith("/auth")) return json(auth);
    if (String(url).includes("/download?")) return new Response(bytes);
    if (String(url).includes("/upload?")) return json({ success: true });
    if (String(url).endsWith("/sandbox/sbx_prime"))
      return json(
        sandbox("TERMINATED", {
          terminatedAt: "2026-09-25T01:00:00Z",
        }),
      );
    throw Error(`unexpected request ${url}`);
  });
  const provider = new PrimeSandboxProvider({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  expect(
    await provider.readFile({
      providerResourceId: "sbx_prime",
      path: "/workspace/a.bin",
      offsetBytes: 1,
      maxBytes: 2,
    }),
  ).toMatchObject({ data: bytes.slice(1, 3), sizeBytes: 4, truncated: true, eof: false });
  expect(
    await provider.writeFile({
      providerResourceId: "sbx_prime",
      path: "/workspace/a.bin",
      data: bytes,
      mode: "overwrite",
    }),
  ).toMatchObject({ bytesWritten: 4 });
  const upload = requests.find((request) => request.url.includes("/upload?"))!;
  expect(upload.init.headers).toMatchObject({ authorization: "Bearer gateway-token" });
  expect(upload.init.body).toBeInstanceOf(FormData);
  const cost = await provider.getCost({
    providerResourceId: "sbx_prime",
    from: new Date("2026-09-25"),
    to: new Date("2026-09-26"),
  });
  expect(cost).toMatchObject({
    amountMicrousd: 91_000n,
    provenance: "estimated_rate_card",
    confidence: "low",
    measuredThrough: new Date("2026-09-25T01:00:00Z"),
  });
  fetchImpl.mockImplementation(async () => json({ detail: "not found" }, 404));
  expect(
    await provider.getCost({
      providerResourceId: "sbx_prime",
      providerMetadata: { prime: sandbox("TERMINATED", { terminatedAt: "2026-09-25T01:00:00Z" }) },
      from: new Date("2026-09-25"),
      to: new Date("2026-09-26"),
    }),
  ).toMatchObject({ amountMicrousd: 91_000n });
  await expect(
    provider.writeFile({
      providerResourceId: "sbx_prime",
      path: "/workspace/a.bin",
      data: bytes,
      mode: "create",
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    provider.readFile({ providerResourceId: "sbx_prime", path: "/../etc/passwd" }),
  ).rejects.toMatchObject({ kind: "invalid_request" });
});
