import { createDatabase } from "@openmetal/db";
import { createLogger } from "@openmetal/logger";
import { loadRootEnv } from "./load-root-env.js";
import { loadWorkerEnv } from "./env.js";
import { buildSandboxProviders } from "./provider-registry.js";
import { createRealtimePublisher } from "./publisher.js";
import { runWorkerLoop } from "./processor.js";

loadRootEnv();

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
const sandboxProviders = buildSandboxProviders(env);
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
