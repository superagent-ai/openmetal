import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
};

describe("database readiness", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });

  beforeAll(async () => {
    expect(await database.ready()).toBe(true);
  });

  afterAll(async () => {
    await database.shutdown();
  });

  it("rejects updates to domain events", async () => {
    await expect(
      database.sql`update metal.domain_events set type = 'nope' where false returning 1`,
    ).resolves.toEqual([]);
  });
});
