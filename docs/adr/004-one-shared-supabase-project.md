# ADR 004: One shared Supabase project per environment

## Context

Web, API, and worker must share Auth identities and one PostgreSQL source of truth.

## Decision

Use local Supabase for each developer and CI. Use one staging project and one production project later. Do not create per-app or per-provider Supabase projects.

## Alternatives

- Separate Auth and database products
- One Supabase project per application
- Auth0 plus a standalone Postgres

## Consequences

RLS, Realtime authorization, and API JWT verification all see the same `sub`. Operational tables live in the unexposed `metal` schema on that same database.
