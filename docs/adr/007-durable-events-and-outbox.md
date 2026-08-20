# ADR 007: Durable events and transactional outbox

## Context

Dashboard updates must survive worker crashes. Realtime cannot be the only copy of an event.

## Decision

`metal.domain_events` is append-only with a monotonic identity cursor. `metal.outbox_jobs` stores publication work. The API inserts state, event, and job in one transaction. The worker claims with `FOR UPDATE SKIP LOCKED`.

## Alternatives

- Listen to Postgres Changes from the dashboard
- Write events after HTTP success without a transaction
- Use an external queue

## Consequences

Clients recover missed events by cursor. Reprocessing a job cannot insert a second domain event with the same `event_id`.
