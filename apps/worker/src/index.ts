import { config as loadEnv } from "dotenv";

loadEnv({ path: "../../.env" });
loadEnv({ path: ".env" });

import { createDatabase } from "@openmetal/db";
import { createLogger } from "@openmetal/logger";
import { BlaxelSandboxProvider } from "@openmetal/provider-blaxel";
import { CloudflareSandboxProvider } from "@openmetal/provider-cloudflare";
import { DaytonaSandboxProvider } from "@openmetal/provider-daytona";
import { E2BSandboxProvider } from "@openmetal/provider-e2b";
import { ModalSandboxProvider } from "@openmetal/provider-modal";
import { NorthflankSandboxProvider } from "@openmetal/provider-northflank";
import { RunloopSandboxProvider } from "@openmetal/provider-runloop";
import { VercelSandboxProvider } from "@openmetal/provider-vercel";
import type { SandboxProvider, SandboxProviderName } from "@openmetal/provider-core";
import { loadWorkerEnv } from "./env.js";
import { createRealtimePublisher } from "./publisher.js";
import { runWorkerLoop } from "./processor.js";

const env = loadWorkerEnv();
const logger = createLogger({
  service: "worker",
  environment: env.METAL_ENVIRONMENT,
  level: env.LOG_LEVEL,
});
const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
const publisher = createRealtimePublisher({
  supabaseUrl: env.SUPABASE_URL,
  secretKey: env.SUPABASE_SECRET_KEY,
});
const sandboxProviders: Partial<Record<SandboxProviderName, SandboxProvider>> = {};
// Prefer Blaxel's native environment names while retaining the Metal-prefixed aliases.
const blaxelApiKey = env.BL_API_KEY ?? env.BLAXEL_API_KEY;
const blaxelWorkspace = env.BL_WORKSPACE ?? env.BLAXEL_WORKSPACE;
if (blaxelApiKey && blaxelWorkspace) {
  sandboxProviders.blaxel = new BlaxelSandboxProvider({
    apiKey: blaxelApiKey,
    workspace: blaxelWorkspace,
    accountId: env.BLAXEL_ACCOUNT_ID,
    apiUrl: env.BLAXEL_API_URL,
    region: env.BLAXEL_REGION,
    defaultImage: env.BLAXEL_DEFAULT_IMAGE,
    defaultMemoryMb: env.BLAXEL_DEFAULT_MEMORY_MB,
  });
}
if (env.CLOUDFLARE_SANDBOX_API_URL && env.CLOUDFLARE_SANDBOX_API_KEY) {
  sandboxProviders.cloudflare = new CloudflareSandboxProvider({
    apiUrl: env.CLOUDFLARE_SANDBOX_API_URL,
    apiKey: env.CLOUDFLARE_SANDBOX_API_KEY,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    analyticsToken: env.CLOUDFLARE_ANALYTICS_API_TOKEN,
  });
}
if (env.DAYTONA_API_KEY) {
  sandboxProviders.daytona = new DaytonaSandboxProvider({
    apiKey: env.DAYTONA_API_KEY,
    apiUrl: env.DAYTONA_API_URL,
    analyticsApiUrl: env.DAYTONA_ANALYTICS_API_URL,
    target: env.DAYTONA_TARGET,
  });
}
if (env.E2B_API_KEY) {
  sandboxProviders.e2b = new E2BSandboxProvider({
    apiKey: env.E2B_API_KEY,
    apiUrl: env.E2B_API_URL,
    templateId: env.E2B_TEMPLATE_ID,
  });
}
if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) {
  sandboxProviders.modal = new ModalSandboxProvider({
    tokenId: env.MODAL_TOKEN_ID,
    tokenSecret: env.MODAL_TOKEN_SECRET,
    appName: env.MODAL_APP_NAME,
    environment: env.MODAL_ENVIRONMENT,
  });
}
// Northflank maps managed sandboxes to deployment services in the configured project.
if (env.NORTHFLANK_API_TOKEN && env.NORTHFLANK_PROJECT_ID) {
  sandboxProviders.northflank = new NorthflankSandboxProvider({
    apiToken: env.NORTHFLANK_API_TOKEN,
    projectId: env.NORTHFLANK_PROJECT_ID,
    teamId: env.NORTHFLANK_TEAM_ID,
    apiUrl: env.NORTHFLANK_API_URL,
    deploymentPlan: env.NORTHFLANK_DEPLOYMENT_PLAN,
    defaultImage: env.NORTHFLANK_DEFAULT_IMAGE,
    ephemeralStorageMb: env.NORTHFLANK_EPHEMERAL_STORAGE_MB,
  });
}
// Runloop Devboxes provide the managed coding-sandbox lifecycle.
if (env.RUNLOOP_API_KEY) {
  const usageRatesMicrousd =
    env.RUNLOOP_VCPU_HOUR_RATE_USD !== undefined &&
    env.RUNLOOP_MEMORY_GB_HOUR_RATE_USD !== undefined &&
    env.RUNLOOP_DISK_GB_HOUR_RATE_USD !== undefined
      ? {
          vcpuHour: BigInt(Math.round(env.RUNLOOP_VCPU_HOUR_RATE_USD * 1_000_000)),
          memoryGbHour: BigInt(Math.round(env.RUNLOOP_MEMORY_GB_HOUR_RATE_USD * 1_000_000)),
          diskGbHour: BigInt(Math.round(env.RUNLOOP_DISK_GB_HOUR_RATE_USD * 1_000_000)),
        }
      : undefined;
  sandboxProviders.runloop = new RunloopSandboxProvider({
    apiKey: env.RUNLOOP_API_KEY,
    apiUrl: env.RUNLOOP_API_URL,
    resourceSize: env.RUNLOOP_RESOURCE_SIZE,
    blueprintId: env.RUNLOOP_BLUEPRINT_ID,
    usageRatesMicrousd,
  });
}
const vercelToken = env.VERCEL_OIDC_TOKEN ?? env.VERCEL_TOKEN;
if (vercelToken && env.VERCEL_PROJECT_ID) {
  sandboxProviders.vercel = new VercelSandboxProvider({
    token: vercelToken,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_TEAM_ID,
    apiUrl: env.VERCEL_API_URL,
  });
}
const abort = new AbortController();
logger.info({ worker_id: env.WORKER_ID }, "worker started");
const loop = runWorkerLoop(database.db, publisher, env, abort.signal, sandboxProviders);
let shutdownPromise: Promise<void> | undefined;

const shutdown = async (signal: string) => {
  shutdownPromise ??= (async () => {
    logger.info({ signal }, "shutting down worker");
    abort.abort();
    await loop;
    await database.shutdown();
    process.exitCode = 0;
  })();
  await shutdownPromise;
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await loop;
