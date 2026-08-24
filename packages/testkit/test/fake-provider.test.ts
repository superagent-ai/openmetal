import { describe, expect, it } from "vitest";
import { exerciseSandboxProvider, FakeSandboxProvider } from "../src/index.js";

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
    expect(provider.resources.size).toBe(0);
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
});
