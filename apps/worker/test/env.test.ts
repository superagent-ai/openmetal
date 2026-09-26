import { expect, it } from "vitest";
import { loadWorkerEnv, resolveWorkerConcurrency } from "../src/env.js";

it("treats empty optional provider environment values as unset", () => {
  const env = loadWorkerEnv({
    DATABASE_URL: "postgresql://localhost/test",
    WORKER_ID: "worker",
    FREESTYLE_API_KEY: "freestyle-key",
    BLAXEL_ACCOUNT_ID: "",
    RUNLOOP_BLUEPRINT_ID: "   ",
    MODAL_ENVIRONMENT: "",
  });

  expect(env.FREESTYLE_API_KEY).toBe("freestyle-key");
  expect(env.BLAXEL_ACCOUNT_ID).toBeUndefined();
  expect(env.RUNLOOP_BLUEPRINT_ID).toBeUndefined();
  expect(env.MODAL_ENVIRONMENT).toBeUndefined();
});

it("applies webhook delivery settings from the environment", () => {
  const env = loadWorkerEnv({
    DATABASE_URL: "postgresql://localhost/test",
    WORKER_ID: "worker",
    WORKER_WEBHOOK_MAX_ATTEMPTS: "3",
    WORKER_WEBHOOK_BASE_BACKOFF_MS: "250",
    WORKER_WEBHOOK_CONCURRENCY: "2",
  });

  expect(env).toMatchObject({
    WORKER_WEBHOOK_MAX_ATTEMPTS: 3,
    WORKER_WEBHOOK_BASE_BACKOFF_MS: 250,
    WORKER_WEBHOOK_CONCURRENCY: 2,
  });
});

it("sizes job concurrency from the database pool unless configured", () => {
  const base = { DATABASE_URL: "postgresql://localhost/test", WORKER_ID: "worker" };
  expect(resolveWorkerConcurrency(loadWorkerEnv(base), 3)).toBe(6);
  expect(resolveWorkerConcurrency(loadWorkerEnv(base), 10)).toBe(16);
  expect(resolveWorkerConcurrency(loadWorkerEnv({ ...base, WORKER_CONCURRENCY: "1" }), 10)).toBe(1);
});
