<p align="center">
  <img src="apps/web/public/openmetal-logo.svg" alt="OpenMetal" width="96" height="96">
</p>

<h1 align="center">OpenMetal</h1>

OpenMetal is the universal compute gateway for AI agents. This repository implements a hosted control plane that provisions CPU sandboxes, routes creation across supported compute providers, manages lifecycle operations, and bills managed usage.

## Product model

Metal is OpenRouter for cloud sandboxes and GPUs:

- Managed Metal capacity is the default. Superagent owns provider contracts and credentials.
- Customers have one Metal account and organization-scoped balance.
- API keys are scoped per project.
- Every provider resource maps back to one Metal organization and project.
- Customers pay Metal; Metal reconciles and pays providers.
- The public API and TypeScript SDK hide provider-specific lifecycle, usage, and billing differences.

The current provider set is Blaxel, Cloudflare, CodeSandbox, Daytona, E2B, Freestyle, Modal, Northflank, Runloop, and Vercel. Provider integrations remain behind one capability-oriented Metal API; they are not separate customer-facing products.

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
- `packages/billing` holds credit purchase fees, the organization ledger, Stripe Checkout, and automatic top ups.
- One Supabase project per environment provides Auth, PostgreSQL, and Realtime.

Prepaid billing uses Stripe Checkout, a 5.5% purchase fee with an $0.80 minimum, and pass-through provider usage. See [docs/billing.md](docs/billing.md).

## Prerequisites

- Node.js 22 or later
- pnpm 11.13.1
- Bun 1.3.11 (for standalone CLI builds)
- Docker (for local Supabase)
- Supabase CLI 2.105.0 or later (`supabase --version`)

## Installation

```bash
pnpm install --frozen-lockfile
```

## OpenMetal CLI

The private `@openmetal/cli` workspace builds the standalone `openmetal` binary. It supports browser login for control-plane administration; project API keys for sandbox lifecycle, argv-based processes, binary filesystem operations, and leased HTTP endpoints; streamed process output; and `--json`/`--no-input` automation. Interactive PTY/terminal sessions and general SSH, WebSocket, or connection APIs remain outside the public surface.

```bash
pnpm --filter @openmetal/cli build
apps/cli/dist/openmetal --help
```

Tagged `cli-v*` releases publish checksum-verified binaries for macOS, Linux, and Windows plus a bundled Node.js package at `@openmetal/cli`. See [docs/cli.md](docs/cli.md) for installation, authentication, command examples, profiles, npm bootstrap, and CI usage, and [docs/runtime.md](docs/runtime.md) for the process, filesystem, and endpoint HTTP contracts.

## OpenMetal Agent Skill

Install the OpenMetal skill to give compatible coding agents detailed CLI and TypeScript SDK guidance for configuring, provisioning, observing, and managing sandboxes:

```bash
npx skills add homanp/metal --skill openmetal
```

The skill follows the open [Agent Skills specification](https://agentskills.io) and works with OpenCode, Claude Code, Codex, Cursor, and other clients supported by the Skills CLI. Its source and reference material are in [`skills/openmetal`](skills/openmetal).

## Environment setup

Shared development secrets live in the committed, encrypted `.env`. That file is Metal-only: do not add variables from other Superagent repos. The private decryption key is stored on the **superagent-team** Dotenvx Armor org, not in git.

Machine-specific values (local Supabase URLs and keys) live in gitignored `.env.local`.

```bash
pnpm exec dotenvx armor login
pnpm supabase:start
pnpm env:local
```

`pnpm env:local` writes `.env.local` and `apps/web/.env.local` from `supabase status`. It also copies shared Google and GitHub OAuth values from encrypted `.env` into `supabase/.env`. Never commit tokens, database passwords, or secret keys.

To change a shared secret:

```bash
pnpm exec dotenvx set STRIPE_SECRET_KEY sk_test_... -f .env
```

`dotenvx set` encrypts the value in place. After the first encrypt, store this repo's private key on superagent-team with `pnpm env:armor`. `pnpm dev` and the integration test scripts load `.env.local` over encrypted `.env` through dotenvx.

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

**Local Auth OAuth**

These values live in encrypted `.env` and are copied to `supabase/.env` by `pnpm env:local`.

| Variable                                  | Source                           |
| ----------------------------------------- | -------------------------------- |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` | Google Cloud OAuth Web client ID |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`    | Google Cloud client secret       |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` | GitHub OAuth App client ID       |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET`    | GitHub OAuth App client secret   |

Metal's local Auth callback is `http://127.0.0.1:55321/auth/v1/callback`, not the CLI callback port 54389.

**Google Cloud (Web application)**

1. Create an OAuth client of type Web application.
2. Authorized JavaScript origins: `http://localhost:3100` and the production origin.
3. Authorized redirect URIs must be the Supabase Auth callback, not the Next.js `/auth/callback` route:
   - Local: `http://127.0.0.1:55321/auth/v1/callback`
   - Hosted: `https://<project-ref>.supabase.co/auth/v1/callback`
4. Scopes: `openid`, `userinfo.email`, `userinfo.profile`.
5. Paste the client ID and secret into encrypted `.env` (`pnpm exec dotenvx set ... -f .env`) and into hosted Authentication → Sign In / Providers → Google. `pnpm env:local` copies those values into `supabase/.env`. Leave Skip nonce check off in hosted; local `config.toml` sets `skip_nonce_check = true`.

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

The SDK also exposes `processes`, `filesystem`, `runtimeOperations`, and `endpoints` namespaces for ready sandboxes. The workspace package remains private, while `pnpm --filter @openmetal/sdk build:npm` produces the self-contained public npm artifact. See [packages/sdk-typescript/README.md](packages/sdk-typescript/README.md) for SDK usage and publishing details.

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

Integration, RLS, and Realtime tests require local Supabase plus `pnpm env:local` so `.env.local` has this machine's keys.

## Common local failures

- **API not ready**: start Supabase before `pnpm dev`. `GET /ready` checks PostgreSQL.
- **401 from the API**: the dashboard session expired. Refresh the page so proxy can rotate cookies.
- **Realtime CHANNEL_ERROR**: confirm the user is a member of the project organization and that the channel is private.
- **Magic link missing**: open Mailpit at `http://127.0.0.1:55324` rather than a real mailbox.
- **OAuth redirect mismatch**: provider callback URLs must be `http://127.0.0.1:55321/auth/v1/callback` locally. The app route is `/auth/callback`.
- **Port already allocated**: `pnpm supabase:stop` then start again. API uses 4000, web uses 3100.
- **Encrypted `.env` will not decrypt**: run `pnpm exec dotenvx armor login` as a member of superagent-team. Do not copy keys from other Superagent repos into this `.env`.
- **`supabase start` missing private key**: use `pnpm supabase:start`, not bare `supabase start`. The CLI reads the encrypted root `.env` and needs dotenvx to decrypt OAuth secrets first.

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
pnpm env:local
pnpm env:encrypt
pnpm env:armor
pnpm db:types
```
