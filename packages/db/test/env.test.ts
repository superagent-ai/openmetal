import { describe, expect, it } from "vitest";
import { DatabaseEnvSchema } from "../src/env.js";

describe("database environment validation", () => {
  it("accepts a postgres url", () => {
    expect(
      DatabaseEnvSchema.parse({
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      }).DATABASE_URL,
    ).toContain("postgresql://");
  });

  it("rejects a missing database url", () => {
    expect(() => DatabaseEnvSchema.parse({ DATABASE_URL: "" })).toThrow();
  });

  it("rejects a non-postgres url", () => {
    expect(() => DatabaseEnvSchema.parse({ DATABASE_URL: "redis://localhost" })).toThrow();
  });
});
