# ADR 001: Monorepo and package boundaries

## Context

Metal needs a dashboard, a public API, a durable worker, a TypeScript SDK, and shared contracts. Later milestones will add providers without rewriting the control plane.

## Decision

Use a pnpm workspace with Turborepo. Applications live in `apps/*`. Shared libraries live in `packages/*`. Do not create empty packages for providers, billing, routing, GPU, or Python.

Web may not import `packages/db`. Product reads and writes go through `@openmetal/sdk` to `apps/api`.

## Alternatives

- A single Next.js app with route handlers as the product API
- A polyrepo per service
- Nx instead of Turborepo

## Consequences

Package boundaries are enforceable in tests and reviews. Builds are incremental. Provider adapters can be added later without changing Milestone 1 packages.
