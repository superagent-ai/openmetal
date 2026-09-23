import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Options, type Sql } from "postgres";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadDatabaseEnv, type DatabaseEnv } from "./env.js";
import { schema } from "./schema.js";

export type MetalDb = PostgresJsDatabase<typeof schema>;

export type MetalDatabase = {
  db: MetalDb;
  sql: Sql;
  ready: () => Promise<boolean>;
  shutdown: () => Promise<void>;
};

const DIRECT_POOL_MAX = 10;
// Supavisor session mode rejects clients above pool_size (15 on this project).
// The API and worker each keep a pool, so 3 clients per process stays under
// that limit instead of opening connections the pooler refuses.
const SUPABASE_POOLER_MAX = 3;
const PoolMaxSchema = z.coerce.number().int().min(1).max(100);

export type PostgresClientOptions = Pick<
  Options<Record<string, never>>,
  "max" | "idle_timeout" | "connect_timeout" | "prepare"
>;

export function postgresClientOptions(
  databaseUrl: string,
  source: { DATABASE_POOL_MAX?: string | undefined } = process.env,
): PostgresClientOptions {
  const pooler = isSupabasePooler(databaseUrl);
  const override = source.DATABASE_POOL_MAX;
  const max =
    override === undefined || override.trim() === ""
      ? pooler
        ? SUPABASE_POOLER_MAX
        : DIRECT_POOL_MAX
      : PoolMaxSchema.parse(override);

  return {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(isTransactionPooler(databaseUrl) ? { prepare: false } : {}),
  };
}

export function createDatabase(env: DatabaseEnv = loadDatabaseEnv()): MetalDatabase {
  const client = postgres(env.DATABASE_URL, postgresClientOptions(env.DATABASE_URL));
  const db = drizzle(client, { schema });

  return {
    db,
    sql: client,
    async ready() {
      try {
        await db.execute(sql`select 1 as ready`);
        return true;
      } catch {
        return false;
      }
    },
    async shutdown() {
      await client.end({ timeout: 5 });
    },
  };
}

export async function withTransaction<T>(db: MetalDb, fn: (tx: MetalDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as MetalDb));
}

function isSupabasePooler(databaseUrl: string): boolean {
  const host = connectionHost(databaseUrl);
  if (host === undefined) return databaseUrl.includes(".pooler.supabase.com");
  return host === "pooler.supabase.com" || host.endsWith(".pooler.supabase.com");
}

function isTransactionPooler(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.port === "6543" || url.searchParams.get("pgbouncer") === "true";
  } catch {
    return databaseUrl.includes(":6543") || /[?&]pgbouncer=true(?:&|$)/.test(databaseUrl);
  }
}

function connectionHost(databaseUrl: string): string | undefined {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return undefined;
  }
}
