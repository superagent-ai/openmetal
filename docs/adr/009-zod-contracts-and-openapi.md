# ADR 009: Shared Zod contracts and OpenAPI

## Context

The API and SDK must reject malformed payloads the same way. OpenAPI must not drift from runtime parsers.

## Decision

Define versioned Zod schemas in `packages/contracts`. Fastify and the SDK parse with those schemas. OpenAPI is generated from the same schemas during the contracts build.

## Alternatives

- TypeBox only inside Fastify
- Hand-written OpenAPI
- Shared TypeScript types without runtime parsers

## Consequences

Invalid requests fail at the boundary. Generated `openapi.json` is mechanically tied to the parsers.
