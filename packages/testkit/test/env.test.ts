import { describe, expect, it } from "vitest";
import { TestEnvSchema } from "../src/env.js";

describe("testkit env", () => {
  it("requires supabase credentials", () => {
    expect(() => TestEnvSchema.parse({})).toThrow();
  });
});
