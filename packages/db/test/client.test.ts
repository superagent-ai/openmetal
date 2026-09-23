import { describe, expect, it } from "vitest";
import { postgresClientOptions } from "../src/client.js";

const directUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const sessionPoolerUrl =
  "postgresql://postgres.example:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const transactionPoolerUrl =
  "postgresql://postgres.example:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres";
const pgbouncerUrl =
  "postgresql://postgres.example:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres?pgbouncer=true";

describe("postgres client pool options", () => {
  it("keeps a larger pool for direct postgres", () => {
    expect(postgresClientOptions(directUrl, {})).toEqual({
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  });

  it("caps supabase session pooler clients below the default pool_size", () => {
    expect(postgresClientOptions(sessionPoolerUrl, {})).toEqual({
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  });

  it("disables prepared statements for the transaction pooler", () => {
    expect(postgresClientOptions(transactionPoolerUrl, {}).prepare).toBe(false);
    expect(postgresClientOptions(pgbouncerUrl, {}).prepare).toBe(false);
  });

  it("honors an explicit pool max", () => {
    expect(postgresClientOptions(sessionPoolerUrl, { DATABASE_POOL_MAX: "2" }).max).toBe(2);
    expect(postgresClientOptions(directUrl, { DATABASE_POOL_MAX: "4" }).max).toBe(4);
  });

  it("rejects a pool max outside 1..100", () => {
    expect(() => postgresClientOptions(directUrl, { DATABASE_POOL_MAX: "0" })).toThrow();
    expect(() => postgresClientOptions(directUrl, { DATABASE_POOL_MAX: "101" })).toThrow();
    expect(() => postgresClientOptions(directUrl, { DATABASE_POOL_MAX: "nope" })).toThrow();
  });
});
