# ADR 010: TypeScript SDK packaging

## Context

The dashboard must not hand-roll Metal HTTP calls. External apps will later install the same client.

## Decision

Develop `@openmetal/sdk` as a private workspace package and publish a self-contained ESM artifact to npm. The publish artifact bundles internal `@openmetal/contracts` runtime and declaration types so customers install one OpenMetal package; Zod remains a normal public runtime dependency.

The SDK validates responses, uses an async access-token provider, times out requests, retries GET only, and sends `Idempotency-Key` on retry-sensitive operations. It has no Supabase database access and no public Realtime topic API.

## Alternatives

- OpenAPI generated client
- Fetch helpers inside `apps/web`
- Publish `@openmetal/contracts` as a separate public package

## Consequences

Dashboard boundary tests fail if web code calls `/v1` or `@openmetal/db` directly. npm packaging must verify runtime imports and TypeScript declarations from a clean consumer project before publishing. The first version is published by an authenticated maintainer; later `sdk-v*` releases use npm trusted publishing.
