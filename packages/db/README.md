# `@openmetal/db`

Server-side Drizzle access to the shared PostgreSQL database.

Connections are created only by `createDatabase()`. Importing this package does not open a pool.

Direct Postgres URLs keep a pool of 10. Supabase pooler hosts (`*.pooler.supabase.com`) default to 3 so the API and worker stay under Supavisor session mode (`pool_size` 15). Transaction-mode pooler URLs (port `6543`, or `pgbouncer=true`) also disable prepared statements. Set `DATABASE_POOL_MAX` to override the cap after raising the pooler limit.

## Synchronization

1. Canonical DDL lives in `supabase/migrations/`.
2. `packages/db/src/schema.ts` is updated by hand to match that DDL.
3. `pnpm db:types` regenerates `src/database.types.ts` from local Supabase.
4. CI diffs the generated types.

Never run Drizzle Kit `generate`/`migrate` against this database.
