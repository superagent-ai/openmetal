import { config as loadEnv } from "dotenv";

loadEnv({ path: "../../.env" });
loadEnv({ path: ".env" });

import { createDatabase } from "@openmetal/db";
import { createLogger } from "@openmetal/logger";
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
const abort = new AbortController();

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down worker");
  abort.abort();
  await database.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ worker_id: env.WORKER_ID }, "worker started");
await runWorkerLoop(database.db, publisher, env, abort.signal);
