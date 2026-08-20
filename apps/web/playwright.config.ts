import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : [
        {
          command: "pnpm exec tsx src/index.ts",
          cwd: join(repoRoot, "apps/api"),
          url: "http://127.0.0.1:4000/health",
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: "pnpm exec tsx src/index.ts",
          cwd: join(repoRoot, "apps/worker"),
          url: "http://127.0.0.1:4000/health",
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: "pnpm --filter @openmetal/web dev",
          url: "http://localhost:3100",
          reuseExistingServer: Boolean(process.env.CI),
          timeout: 120_000,
        },
      ],
});
