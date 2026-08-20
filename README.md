# Metal

Metal is the universal compute gateway for AI agents. This repository currently implements **Milestone 1**: the production control plane foundation. It does not provision sandboxes, talk to compute providers, route workloads, or bill usage.

## Product model

Metal is OpenRouter for cloud sandboxes and GPUs:

- Managed Metal capacity is the default. Superagent owns provider contracts and credentials.
- Customers have one Metal account and organization-scoped balance.
- API keys are scoped per project.
- Every provider resource maps back to one Metal organization and project.
- Customers pay Metal; Metal reconciles and pays providers.
- The public API and TypeScript SDK hide provider-specific lifecycle, usage, and billing differences.

The initial provider set is E2B, Daytona, Modal, Railway, and Vercel. Provider integrations remain behind one capability-oriented Metal API; they are not separate customer-facing products.

## Architecture

```text
apps/web  --Auth/Realtime-->  Supabase
apps/web  --MetalClient---->  apps/api  --Drizzle-->  PostgreSQL
apps/api  --outbox-------->  apps/worker --Broadcast--> Supabase Realtime
```

- `apps/web` is the Next.js dashboard. It uses Supabase only for login, logout, confirmation, session refresh, and authorized private Realtime channels.
- `apps/api` is the only public product API. It authenticates Supabase JWTs, authorizes every org/project operation, and writes product state, a durable event, and an outbox job in one transaction.
- `apps/worker` claims outbox jobs with `FOR UPDATE SKIP LOCKED` and publishes committed events to private Broadcast topics.
- `packages/sdk-typescript` (`@openmetal/sdk`) is the only way the dashboard talks to the Metal API.
- `packages/contracts` holds runtime Zod schemas shared by the API and SDK.
- One Supabase project per environment provides Auth, PostgreSQL, and Realtime.

## Prerequisites

- Node.js 22 or later
- pnpm 11.13.1
- Docker (for local Supabase)
- Supabase CLI 2.105.0 or later (`supabase --version`)

## Installation

```bash
pnpm install --frozen-lockfile
```

## Environment setup

```bash
cp .env.example .env
pnpm supabase:start
pnpm env:local
```

`pnpm env:local` copies values from `supabase status` into gitignored `.env` files. Never commit tokens, database passwords, or secret keys.

## Local Supabase lifecycle

```bash
pnpm supabase:start
pnpm supabase:reset
pnpm supabase:stop
pnpm db:types
```

Studio is at `http://127.0.0.1:55323`. Local mail (magic links) is at `http://127.0.0.1:55324`. The API gateway is at `http://127.0.0.1:55321` and Postgres is at `127.0.0.1:55322`. These host ports avoid clashing with another local Supabase stack.

## Migration workflow

Supabase migrations in `supabase/migrations/` are the canonical schema history. Do not generate a second migration stream with Drizzle Kit.

1. `supabase migration new <name>`
2. Edit the generated SQL
3. `pnpm supabase:reset`
4. Update `packages/db/src/schema.ts` so it matches the SQL
5. `pnpm db:types` and commit the generated `packages/db/src/database.types.ts`

## Auth flow

The dashboard uses `@supabase/ssr` with a browser client, a server client, and `src/proxy.ts` session refresh. Magic links land on `/auth/confirm`, which exchanges `token_hash` for a cookie session. The dashboard then constructs `MetalClient` with the current Supabase access token.

The API verifies that token with `supabase.auth.getClaims()` and authorizes from the verified `sub` claim. It never trusts `user_metadata`.

## API and worker division

The API never calls providers and does not publish Realtime events inside the originating HTTP request. The worker is the trusted publisher. Duplicate job delivery is safe: domain events are append-only and unique on `event_id`, and the dashboard deduplicates by event ID and cursor.

## SDK usage

```ts
import { MetalClient } from "@openmetal/sdk";

const metal = new MetalClient({
  baseUrl: "http://localhost:4000",
  accessToken: async () => currentSupabaseAccessToken,
});

await metal.health();
await metal.organizations.create({ name: "Northwind", slug: "northwind" });
await metal.projects.create(organizationId, { name: "Alpha", slug: "alpha" });
await metal.events.list({ projectId, after: cursor });
```

The package is private and is not published.

## Realtime delivery and cursor recovery

The worker broadcasts to private topics `organization:<id>` and `project:<id>` after the event is committed. Clients subscribe with `{ private: true }`. On subscribe or reconnect they call `GET /v1/events?project_id=&after=`. Realtime is never the only copy of an event.

## Testing

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:rls
pnpm test:realtime
```

Integration, RLS, and Realtime tests require local Supabase plus `pnpm env:local`.

## Common local failures

- **API not ready**: start Supabase before `pnpm dev`. `GET /ready` checks PostgreSQL.
- **401 from the API**: the dashboard session expired. Refresh the page so proxy can rotate cookies.
- **Realtime CHANNEL_ERROR**: confirm the user is a member of the project organization and that the channel is private.
- **Magic link missing**: open Mailpit at `http://127.0.0.1:55324` rather than a real mailbox.
- **Port already allocated**: `pnpm supabase:stop` then start again. API uses 4000, web uses 3100.

## Root commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:rls
pnpm test:realtime
pnpm format
pnpm format:check
pnpm supabase:start
pnpm supabase:stop
pnpm supabase:reset
pnpm db:types
```
