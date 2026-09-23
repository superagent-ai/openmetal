# ADR 013: Publish Realtime Broadcast from Postgres

## Context

The worker published each domain event by claiming a `realtime.broadcast` outbox job and calling the Realtime REST API with the Supabase secret key. That added an HTTP hop, a poll interval, and a second credential per service. In production every publish returned 403 while subscriptions kept working, so dashboards stayed silent and the only trace was `last_error` on failed outbox jobs.

## Decision

`insertDomainEventAndBroadcast` calls `realtime.send(payload, type, topic, true)` in the transaction that records the domain event. `realtime.messages` acts as Supabase's own transactional outbox: Realtime reads it through logical replication, so it delivers only committed rows and never broadcasts rolled-back work.

Authorization from ADR 008 is unchanged. Members join through the `SELECT` policy on `realtime.messages`, and authenticated users still cannot insert. The API and worker call `realtime.send` as the `postgres` role, which bypasses row-level security. The worker no longer needs `SUPABASE_URL` or `SUPABASE_SECRET_KEY`, and it drains any queued `realtime.broadcast` jobs through the same function.

## Alternatives

- Keep the worker publishing through the Realtime REST API
- Keep the outbox job and have the worker call `realtime.send` when it claims it
- Postgres Changes on `metal.domain_events`

## Consequences

Broadcasts arrive after commit plus replication lag instead of after the next worker poll. `realtime.send` downgrades its failures to warnings, so a lost broadcast never rolls back product state, and clients still recover through `GET /v1/events`. Each domain event adds one row to `realtime.messages`, whose daily partitions Realtime prunes. `realtime.send` adds an `id` key to each payload, which the dashboard's envelope parser strips.

Supersedes the publishing responsibilities in ADR 003, ADR 007, and ADR 008.
