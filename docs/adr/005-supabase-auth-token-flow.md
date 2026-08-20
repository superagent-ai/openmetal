# ADR 005: Supabase Auth token flow into the Metal API

## Context

The dashboard already holds a Supabase session. Metal API keys are a later milestone.

## Decision

The browser passes the current Supabase access token to `MetalClient`. The API verifies it with `supabase.auth.getClaims()`, which uses JWKS locally for asymmetric keys and the Auth server for symmetric local keys. Authorization uses the verified `sub` claim only.

## Alternatives

- Decode JWT payloads without verifying signatures
- Use deprecated Auth Helpers
- Share the service-role key with the dashboard

## Consequences

Expired and forged tokens return 401. Membership checks are independent of `user_metadata`. Token refresh is the dashboard's job via `@supabase/ssr`.
