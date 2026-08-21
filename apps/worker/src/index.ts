import { config as loadEnv } from "dotenv";

loadEnv({ path: "../../.env" });
loadEnv({ path: ".env" });

import { createDatabase } from "@openmetal/db";
import { createLogger } from "@openmetal/logger";
import { DaytonaSandboxProvider } from "@openmetal/provider-daytona";
import { ModalSandboxProvider } from "@openmetal/provider-modal";
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
if (env.DAYTONA_API_KEY) {
  sandboxProviders.daytona = new DaytonaSandboxProvider({
    apiKey: env.DAYTONA_API_KEY,
    apiUrl: env.DAYTONA_API_URL,
    analyticsApiUrl: env.DAYTONA_ANALYTICS_API_URL,
    target: env.DAYTONA_TARGET,
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
