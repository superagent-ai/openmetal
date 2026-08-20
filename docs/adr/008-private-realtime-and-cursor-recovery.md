# ADR 008: Private Realtime Broadcast plus cursor recovery

## Context

The dashboard needs low-latency project updates without exposing Postgres WAL payloads or allowing customers to publish system events.

## Decision

Use private Supabase Realtime Broadcast. Authorize `SELECT` on `realtime.messages` from organization/project membership. Do not grant customer `INSERT` for broadcasts. The worker publishes with the secret key after commit. On subscribe or reconnect, clients call `GET /v1/events`.

## Alternatives

- Postgres Changes
- Public Broadcast channels
- SSE from the Metal API

## Consequences

Unauthorized users cannot join `project:<id>`. Duplicate broadcasts are suppressed in the UI by event ID. Disconnect recovery is proven through the API, not through Realtime replay.
