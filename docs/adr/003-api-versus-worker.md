# ADR 003: API versus worker responsibilities

## Context

Provisioning and other later operations are slow and ambiguous. Even Milestone 1 must not hide asynchronous work inside the originating HTTP request.

## Decision

The API writes durable desired state, an append-only event, and an outbox job in one transaction, then returns. The worker claims jobs, publishes Realtime Broadcasts, retries with bounded backoff, and records terminal failure.

## Alternatives

- Publish Realtime from the API after commit
- Use Redis, Kafka, or Temporal for jobs
- Inline worker loops in the API process

## Consequences

HTTP handlers stay bounded. Worker crashes do not lose committed jobs. Duplicate delivery is expected and must be idempotent.
