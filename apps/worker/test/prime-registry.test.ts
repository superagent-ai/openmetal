import { expect, it } from "vitest";
import { WorkerEnvSchema } from "../src/env.js";
import { buildByokSandboxProvider, buildSandboxProviders } from "../src/provider-registry.js";

it("registers Prime for managed capacity and organization BYOK credentials", () => {
  const env = WorkerEnvSchema.parse({
    DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    WORKER_ID: "prime-test",
    PRIME_API_KEY: "managed-key",
    PRIME_TEAM_ID: "managed-team",
  });
  expect(buildSandboxProviders(env).prime?.name).toBe("prime");
  expect(
    buildByokSandboxProvider({ provider: "prime", api_key: "byok-key", team_id: "team-1" }).name,
  ).toBe("prime");
});
