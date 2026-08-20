# ADR 006: Canonical Supabase migrations with Drizzle

## Context

The repo needs reviewed SQL history and type-safe server queries. Two independent migration generators would diverge.

## Decision

Supabase CLI migrations are canonical. Drizzle schemas in `packages/db` are a typed projection of that SQL. `pnpm db:types` generates Supabase TypeScript types. Drizzle Kit is not used to emit migrations.

## Alternatives

- Drizzle Kit as the migration source
- Prisma migrate
- Hand-written TypeScript with no SQL files

## Consequences

CI fails if generated types drift. Schema changes require a new `supabase migration new` file plus a matching Drizzle update.
