# ADR 010: TypeScript SDK packaging

## Context

The dashboard must not hand-roll Metal HTTP calls. External apps will later install the same client.

## Decision

Ship `@openmetal/sdk` as a private, independently buildable ESM package. It validates responses, uses an async access-token provider, times out requests, retries GET only, and sends `Idempotency-Key` on organization and project creation. It has no Supabase database access and no public Realtime topic API.

## Alternatives

- OpenAPI generated client
- Fetch helpers inside `apps/web`
- Publish to npm in Milestone 1

## Consequences

Dashboard boundary tests fail if web code calls `/v1` or `@openmetal/db` directly. Publishing waits for a later milestone.
