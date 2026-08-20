# `@openmetal/db`

Server-side Drizzle access to the shared PostgreSQL database.

Connections are created only by `createDatabase()`. Importing this package does not open a pool.

## Synchronization

1. Canonical DDL lives in `supabase/migrations/`.
2. `packages/db/src/schema.ts` is updated by hand to match that DDL.
3. `pnpm db:types` regenerates `src/database.types.ts` from local Supabase.
4. CI diffs the generated types.

Never run Drizzle Kit `generate`/`migrate` against this database.
