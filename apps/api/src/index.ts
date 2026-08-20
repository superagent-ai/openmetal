import { config as loadEnv } from "dotenv";

loadEnv({ path: "../../.env" });
loadEnv({ path: ".env" });

import { createLogger } from "@openmetal/logger";
import { buildApp } from "./app.js";
import { loadApiEnv } from "./env.js";

const env = loadApiEnv();
const log = createLogger({
  service: "api",
  environment: env.METAL_ENVIRONMENT,
  level: env.LOG_LEVEL,
});
const { app } = await buildApp(env);
let shutdownPromise: Promise<void> | undefined;

const shutdown = async (signal: string) => {
  shutdownPromise ??= (async () => {
    log.info({ signal }, "shutting down api");
    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      log.error({ err: error, signal }, "api shutdown failed");
      process.exitCode = 1;
    }
  })();
  await shutdownPromise;
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
