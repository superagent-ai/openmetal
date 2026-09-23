import { expect, it } from "vitest";
import { loadWorkerEnv } from "../src/env.js";

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
