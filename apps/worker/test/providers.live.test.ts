import { config as loadEnvFile } from "dotenv";
import { describe, expect, it } from "vitest";
import type { SandboxProviderName } from "@openmetal/provider-core";
import { loadWorkerEnv } from "../src/env.js";
import { buildSandboxProviders } from "../src/provider-registry.js";

loadEnvFile({ path: "../../.env", override: true });

const enabled = process.env.METAL_LIVE_TESTS === "1";
const env = enabled ? loadWorkerEnv() : undefined;
const providers = env ? buildSandboxProviders(env) : {};
const requestedProviders = new Set(
  (process.env.METAL_LIVE_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const configured = Object.entries(providers).filter(
  ([name, provider]) => provider && (requestedProviders.size === 0 || requestedProviders.has(name)),
) as Array<[SandboxProviderName, NonNullable<(typeof providers)[SandboxProviderName]>]>;

(enabled ? describe.sequential : describe.skip)("live sandbox provider conformance", () => {
  for (const [name, provider] of configured) {
    it(
      `${name}: create, lifecycle, cost, and idempotent cleanup`,
      async () => {
        const runId = crypto.randomUUID().replaceAll("-", "");
        const metalSandboxId = `sbx_live${runId}`;
        let providerResourceId: string | undefined;
        let providerOrganizationId: string | undefined;
        let providerMetadata: Record<string, unknown> | undefined;
        const startedAt = new Date();
        try {
          const created = await provider.create({
            metalSandboxId,
            organizationId: "11111111-1111-4111-8111-111111111111",
            projectId: "22222222-2222-4222-8222-222222222222",
            language: "typescript",
            ttlMinutes: 10,
            source: {
              kind: "environment",
              environment: "metal/node",
              version: "live",
            },
            resources: {
              vcpu: 0.5,
              memoryMb: 512,
              architecture: "any",
            },
            lifecycle: {
              runtimeTimeoutSeconds: 600,
              onRuntimeTimeout: "destroy",
              onIdleTimeout: "destroy",
            },
            providerOptions: {},
            environment: {},
            secretRefs: {},
            metadata: {
              "metal.live_test": "1",
              "metal.run_id": runId,
              "metal.provider": name,
            },
            signal: AbortSignal.timeout(Number(process.env.METAL_LIVE_TIMEOUT_MS ?? 300_000)),
          });
          providerResourceId = created.providerResourceId;
          providerOrganizationId = created.providerOrganizationId;
          providerMetadata = created.providerMetadata;
          expect(providerResourceId).toBeTruthy();
          if (created.resolvedResources) {
            expect(created.resolvedResources.vcpu).toBeGreaterThanOrEqual(0.5);
            expect(created.resolvedResources.memoryMb).toBeGreaterThanOrEqual(512);
          }
          if (provider.capabilities.pause) {
            await provider.pause(providerResourceId);
            if (provider.capabilities.resume && provider.resume) {
              await provider.resume(providerResourceId);
            }
          }
          if (provider.capabilities.cost) {
            const cost = await provider.getCost({
              providerResourceId,
              providerOrganizationId,
              providerMetadata,
              from: startedAt,
              to: new Date(),
            });
            if (cost) expect(cost.amountMicrousd).toBeGreaterThanOrEqual(0n);
          }
        } finally {
          if (providerResourceId) {
            await provider.destroy(providerResourceId).catch(() => undefined);
            await provider.destroy(providerResourceId).catch(() => undefined);
          }
        }
      },
      Number(process.env.METAL_LIVE_TIMEOUT_MS ?? 300_000),
    );
  }

  it("has at least one configured provider", () => {
    expect(configured.length).toBeGreaterThan(0);
  });
});
