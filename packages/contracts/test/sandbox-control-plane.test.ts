import { describe, expect, it } from "vitest";
import {
  CreateSandboxRequestSchema,
  OperationSchema,
  SandboxMutationSchema,
} from "../src/index.js";

const request = {
  provider: "codesandbox",
  source: { kind: "environment", environment: "metal/node", version: "1" },
  resources: { vcpu: 2, memory_mb: 4096, disk_mb: 8192, architecture: "any" },
  lifecycle: { runtime_timeout_seconds: 3600 },
  fallback: { providers: ["e2b", "runloop"] },
  provider_options: {
    codesandbox: { vm_tier: "Nano" },
    runloop: { resource_size: "SMALL" },
  },
};

describe("unified sandbox contracts", () => {
  it("parses provider-required minimum resources and ordered fallback", () => {
    const parsed = CreateSandboxRequestSchema.parse(request);
    expect(parsed.provider).toBe("codesandbox");
    expect(parsed.resources.memory_mb).toBe(4096);
    expect(parsed.fallback.providers).toEqual(["e2b", "runloop"]);
  });

  it("accepts auto routing and omits empty optional objects", () => {
    const parsed = CreateSandboxRequestSchema.parse({
      source: { kind: "environment", environment: "metal/node" },
      resources: { vcpu: 1, memory_mb: 1024 },
      lifecycle: { runtime_timeout_seconds: 600 },
      regions: ["iad1", "fra1"],
      features: {
        isolation: ["microvm"],
        pty: true,
        pause_resume: true,
        public_ports: [3000],
      },
      network: {
        internet_access: true,
        deny_domains: ["example.invalid"],
      },
    });
    expect(parsed.provider).toBeUndefined();
    expect(parsed.fallback).toBeUndefined();
    expect(parsed.provider_options).toBeUndefined();
    expect(parsed.features?.public_ports).toEqual([3000]);
  });

  it("rejects duplicate candidates and options for unselected providers", () => {
    expect(() =>
      CreateSandboxRequestSchema.parse({
        ...request,
        fallback: { providers: ["codesandbox"] },
      }),
    ).toThrow();
    expect(() =>
      CreateSandboxRequestSchema.parse({
        ...request,
        provider_options: { modal: {} },
      }),
    ).toThrow();
  });

  it("rejects fallback for provider templates", () => {
    expect(() =>
      CreateSandboxRequestSchema.parse({
        ...request,
        source: {
          kind: "provider_template",
          provider: "codesandbox",
          template: "template",
        },
      }),
    ).toThrow();
  });

  it("parses operation mutation envelopes", () => {
    const operation = OperationSchema.parse({
      id: "op_123",
      project_id: "prj_123",
      type: "sandbox_create",
      state: "queued",
      resource_type: "sandbox",
      resource_id: "sbx_123",
      retryable: false,
      error: null,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
      completed_at: null,
    });
    expect(
      SandboxMutationSchema.safeParse({
        sandbox: {
          id: "sbx_123",
          type: "sandbox",
          project_id: "prj_123",
          state: "routing",
          state_reason: null,
          requested: request,
          provider: null,
          billing_mode: "managed",
          resolved_resources: null,
          cost_microusd: null,
          cost_updated_at: null,
          created_at: "2026-08-24T00:00:00.000Z",
          updated_at: "2026-08-24T00:00:00.000Z",
          ready_at: null,
          paused_at: null,
          stopped_at: null,
          metadata: {},
        },
        operation,
      }).success,
    ).toBe(true);
  });
});
