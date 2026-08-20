import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import { loadDatabaseEnv, type DatabaseEnv } from "./env.js";
import { schema } from "./schema.js";

export type MetalDb = PostgresJsDatabase<typeof schema>;

export type MetalDatabase = {
  db: MetalDb;
  sql: Sql;
  ready: () => Promise<boolean>;
  shutdown: () => Promise<void>;
};

export function createDatabase(env: DatabaseEnv = loadDatabaseEnv()): MetalDatabase {
  const client = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
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
