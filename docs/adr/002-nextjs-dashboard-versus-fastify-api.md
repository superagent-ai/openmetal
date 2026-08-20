# ADR 002: Next.js dashboard versus separate Fastify API

## Context

The dashboard needs Supabase cookie sessions. The product API must be a stable, versioned HTTPS control plane usable from SDKs that are not Next.js.

## Decision

Keep `apps/web` on Next.js App Router for Auth UI and the dashboard. Keep `apps/api` as a standalone Fastify server under `/v1`. Next.js route handlers exist only for Auth confirmation and logout.

## Alternatives

- Implement the Metal API as Next.js route handlers
- Serve the dashboard from Fastify
- Use tRPC across the monolith

## Consequences

The TypeScript SDK has one HTTP base URL. Browser cookies never become the API authorization mechanism. CORS is an explicit allowlist.
