import { expect, it, vi } from "vitest";
import { NorthflankSandboxProvider } from "../src/index.js";

it("declares the Northflank provider contract", () => {
  const provider = new NorthflankSandboxProvider({ apiToken: "test", projectId: "test" });
  expect(provider.name).toBe("northflank");
  expect(provider.capabilities.resume).toBe(true);
  expect(provider.capabilities.runtime).toMatchObject({
    process: { exec: false, streams: false, cancel: false },
    files: {
      read: false,
      write: false,
      writeModes: [],
      createParents: false,
      list: false,
      delete: false,
    },
  });
  expect(provider.capabilities.runtime.httpEndpoints).toBeUndefined();
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
});

it("marks Northflank hourly billing totals as provider reported", async () => {
  const hourlyPayload = {
    resources: [{ id: "service-1", price: { total: 2.5 } }],
    pagination: { hasNextPage: false },
  };
  const provider = new NorthflankSandboxProvider({
    apiToken: "test",
    projectId: "project-1",
    fetchImpl: vi.fn().mockResolvedValue(json(hourlyPayload)),
  });

  const cost = await provider.getCost({
    providerResourceId: "service-1",
    from: new Date("2026-08-27T10:00:00.000Z"),
    to: new Date("2026-08-27T10:00:00.000Z"),
  });

  expect(cost).toMatchObject({
    amountMicrousd: 25_000n,
    provenance: "provider_reported",
    confidence: "high",
    source: "northflank-hourly-billing-usage",
    raw: { hours: [hourlyPayload] },
  });
});

it("starts a requested command for endpoint-only sandboxes", async () => {
  let createBody: Record<string, unknown> | undefined;
  const ready = {
    data: {
      name: "metal-sbx-live-test",
      status: { deployment: { status: "COMPLETED" } },
    },
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") {
      createBody = JSON.parse(String(init.body));
    }
    return json(ready);
  });
  const provider = new NorthflankSandboxProvider({
    apiToken: "test",
    projectId: "test",
    fetchImpl,
  });

  await provider.create({
    metalSandboxId: "sbx-live-test",
    organizationId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    image: "node:22-alpine",
    language: "typescript",
    ttlMinutes: 10,
    source: {
      kind: "environment",
      environment: "metal/node",
      command: ["node", "-e", "require('http').createServer().listen(3000)"],
    },
    resources: { vcpu: 0.5, memoryMb: 512, architecture: "any" },
    lifecycle: {
      runtimeTimeoutSeconds: 600,
      onRuntimeTimeout: "destroy",
      onIdleTimeout: "destroy",
    },
  });

  expect(createBody).toMatchObject({
    deployment: {
      docker: {
        configType: "customCommand",
        customCommand: "'node' '-e' 'require('\\''http'\\'').createServer().listen(3000)'",
      },
      external: { imagePath: "node:22-alpine" },
    },
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
