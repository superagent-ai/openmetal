import { config as loadEnvFile } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, organizations } from "@openmetal/db";
import type { SandboxProviderName } from "@openmetal/provider-core";
import { listOrganizationByokProviders } from "../src/provider-credentials.js";

loadEnvFile({ path: "../../.env", override: true });

const enabled = process.env.METAL_LIVE_TESTS === "1";
const databaseUrl = process.env.DATABASE_URL;
const organizationSlug = process.env.METAL_BYOK_ORGANIZATION_SLUG;
const providerName = process.env.METAL_BYOK_PROVIDER as SandboxProviderName | undefined;
const database = enabled && databaseUrl ? createDatabase({ DATABASE_URL: databaseUrl }) : undefined;

(enabled ? describe.sequential : describe.skip)("live BYOK provider conformance", () => {
  afterAll(async () => {
    await database?.shutdown();
  });

  it(
    "decrypts the configured credential, creates a sandbox, and cleans it up",
    async () => {
      expect(database).toBeDefined();
      expect(organizationSlug).toBeTruthy();
      expect(providerName).toBeTruthy();
      const organization = await database!.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, organizationSlug!))
        .then((rows) => rows[0]);
      expect(organization).toBeDefined();

      const configured = await listOrganizationByokProviders(database!.db, organization!.id);
      const resolved = configured[providerName!];
      expect(resolved).toBeDefined();
      expect(resolved!.provider.name).toBe(providerName);

      const runId = crypto.randomUUID().replaceAll("-", "");
      const metalSandboxId = `sbx_byok${runId}`;
      let providerResourceId: string | undefined;
      try {
        const created = await resolved!.provider.create({
          metalSandboxId,
          organizationId: organization!.id,
          projectId: crypto.randomUUID(),
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
            "metal.credential_source": "byok",
          },
          signal: AbortSignal.timeout(Number(process.env.METAL_LIVE_TIMEOUT_MS ?? 300_000)),
        });
        providerResourceId = created.providerResourceId;
        expect(providerResourceId).toBeTruthy();
        expect(created.providerOrganizationId).toBeTruthy();
      } finally {
        if (providerResourceId) {
          const timeoutMs = Number(process.env.METAL_LIVE_TIMEOUT_MS ?? 300_000);
          await resolved!.provider.destroy(providerResourceId, AbortSignal.timeout(timeoutMs));
          await resolved!.provider.destroy(providerResourceId, AbortSignal.timeout(timeoutMs));
        }
      }
    },
    Number(process.env.METAL_LIVE_TIMEOUT_MS ?? 300_000),
  );
});
