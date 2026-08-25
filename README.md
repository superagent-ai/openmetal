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
cp supabase/.env.example supabase/.env
pnpm supabase:start
pnpm env:local
```

`pnpm env:local` copies values from `supabase status` into gitignored `.env` files. It does not write OAuth secrets. Fill `supabase/.env` with Google and GitHub client credentials to test social login locally. Never commit tokens, database passwords, or secret keys.

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

The dashboard uses `@supabase/ssr` with a browser client, a server client, and `src/proxy.ts` session refresh.

- Magic links land on `/auth/confirm`, which exchanges `token_hash` for a cookie session.
- Google and GitHub OAuth land on `/auth/callback`, which exchanges the PKCE `code` for a cookie session.

The dashboard then constructs `MetalClient` with the current Supabase access token. The API verifies that token with `supabase.auth.getClaims()` and authorizes from the verified `sub` claim. It never trusts `user_metadata`.

OAuth client IDs and secrets belong to Supabase Auth, not the Next.js app. Do not set them as `NEXT_PUBLIC_*` variables. `NEXT_PUBLIC_SITE_URL` must be the public app origin so `redirectTo` points at `/auth/callback`.

## Google and GitHub login

Local Auth reads credentials from `supabase/.env` via `config.toml` `env()` substitution. After changing `config.toml`, run `pnpm supabase:stop` then `pnpm supabase:start`. `pnpm supabase:reset` is not enough.

**Local `supabase/.env`**

| Variable                                  | Source                           |
| ----------------------------------------- | -------------------------------- |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` | Google Cloud OAuth Web client ID |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`    | Google Cloud client secret       |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` | GitHub OAuth App client ID       |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET`    | GitHub OAuth App client secret   |

Metal's local Auth callback is `http://127.0.0.1:55321/auth/v1/callback`, not the CLI default port 54321.

**Google Cloud (Web application)**

1. Create an OAuth client of type Web application.
2. Authorized JavaScript origins: `http://localhost:3100` and the production origin.
3. Authorized redirect URIs must be the Supabase Auth callback, not the Next.js `/auth/callback` route:
   - Local: `http://127.0.0.1:55321/auth/v1/callback`
   - Hosted: `https://<project-ref>.supabase.co/auth/v1/callback`
4. Scopes: `openid`, `userinfo.email`, `userinfo.profile`.
5. Paste the client ID and secret into `supabase/.env` and into hosted Authentication → Sign In / Providers → Google. Leave Skip nonce check off in hosted; local `config.toml` sets `skip_nonce_check = true`.

**GitHub OAuth App**

GitHub allows one callback URL per app, so use separate apps for local and hosted, or configure only the environment you are testing.

- Homepage URL: the app origin.
- Authorization callback URL:
  - Local: `http://127.0.0.1:55321/auth/v1/callback`
  - Hosted: `https://<project-ref>.supabase.co/auth/v1/callback`

**Hosted Supabase Dashboard → Authentication → URL Configuration**

- Site URL: production app origin (must match `NEXT_PUBLIC_SITE_URL`). The dashboard default `http://localhost:3000` is wrong for Metal.
- Redirect URLs: add `https://<prod>/auth/callback`, `https://<prod>/auth/callback**`, and keep `/auth/confirm` for magic links. Add `http://localhost:3100/auth/callback` and `http://localhost:3100/auth/callback**` if you test hosted Auth from local web.

Enable Google and GitHub under Providers and paste the same credentials. No schema migration is required.

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
- **OAuth redirect mismatch**: provider callback URLs must be `http://127.0.0.1:55321/auth/v1/callback` locally. The app route is `/auth/callback`.
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
