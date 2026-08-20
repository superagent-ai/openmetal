# Superagent Metal Agent Operating Contract

This file governs coding agents working in the Metal repository. Read `VISION.md`, this file, and `BUILD_PLAN.md` completely before changing code.

## Authority and precedence

When instructions conflict, use this order:

1. Explicit user instruction
2. Security and legal constraints
3. `VISION.md` product invariants
4. The active milestone in `BUILD_PLAN.md`
5. This operating contract
6. Existing implementation conventions

Do not reinterpret an explicit MVP exclusion as optional scope.

## Mission

Build Metal as a trustworthy hosted compute control plane: one API key, one balance, and capability-based routing across compute providers. The active MVP implements sandboxes. Cloud computers are the next resource family, followed by cloud GPU machines as a distinct product under the same control plane.

Metal is not a new sandbox runtime or GPU cloud. Do not build provider infrastructure, a scheduler for Metal-owned machines, Kubernetes abstractions, or future GPU products unless the active milestone explicitly requires them.

Shared control-plane infrastructure does not require shared resource semantics. Future GPU machines may reuse identity, routing, billing, limits, audit, and observability, but must not be forced through the sandbox lifecycle or API merely to reduce implementation work.

## Mandatory working method

### 1. Work on one milestone at a time

Only implement the current milestone. A later milestone may be referenced for interface compatibility, but its functionality must not be pulled forward without necessity.

Before implementation:

- Restate the milestone objective.
- Inspect the existing code and tests.
- List the acceptance checks that will prove completion.
- Identify any ambiguity that changes a public contract, security boundary, accounting behavior, or irreversible data model.

### 2. Build the smallest complete vertical slice

Prefer an end-to-end implementation with real validation over many disconnected abstractions. No placeholder production paths, fake success responses, commented-out critical logic, or TODOs that are required for the active milestone to work.

Test doubles are allowed only in tests or explicitly named development adapters.

### 3. Verify before advancing

Run every verification required by the milestone. Record commands, results, and relevant evidence in the milestone completion note.

A milestone is incomplete if:

- Required tests are skipped or quarantined.
- Verification depends on manual assumptions that can be automated.
- Error, timeout, idempotency, or cleanup paths are untested.
- Documentation claims behavior that has not been demonstrated.
- The implementation works only for a mock when the milestone requires a real provider.

Do not begin the next milestone until the current exit gate passes.

### 4. Stop when blocked

Stop and ask for direction when:

- A missing product choice changes the public API or billing model.
- Provider terms do not clearly allow the intended managed-account behavior.
- A security property cannot be implemented consistently across eligible providers.
- A migration risks destroying or corrupting non-test data.
- A required external credential, account, contract, or permission is absent.
- Verification exposes a product-level contradiction rather than an implementation bug.

Do not bypass provider restrictions, weaken a hard constraint, fabricate provider behavior, or silently substitute BYOK for managed billing.

## Product invariants

These rules apply across every milestone.

### Portable core

- Public portable behavior is defined in provider-neutral contracts.
- Provider SDK types never appear in public core API types.
- Provider-specific features live under explicit extension namespaces.
- Unsupported capabilities produce structured errors before provisioning when known.
- Capability values record their evidence level: `verified`, `provider_reported`, or `unknown`.
- Unknown is never treated as satisfying a hard security requirement.

### Routing

- Apply hard eligibility filters before ranking.
- Persist the inputs and result of every routing decision.
- Use deterministic scoring for identical catalog and observation inputs.
- Explicit provider selection bypasses ranking but not capability validation.
- Fallback may retry sandbox creation; it may not claim to migrate a running sandbox.
- Never retry a non-idempotent operation unless the protocol proves it safe.

### Lifecycle

- Every sandbox belongs to one project and one authenticated principal.
- Create accepts an idempotency key and must not leak duplicate live sandboxes after retries.
- Destroy is idempotent.
- Partial provisions are recorded and reconciled by a cleanup worker.
- Provider IDs are internal and never used as the customer's primary identity.
- Timeouts, cancellation, and provider-unknown states are first-class states.

### Billing and accounting

- Never use binary floating point for money.
- Store quoted, estimated, upstream, customer, refunded, and adjustment amounts separately.
- Customer balance changes occur only through balanced append-only ledger transactions.
- Provider usage events are immutable; corrections create new events.
- Every charge links to a project, sandbox, usage interval, pricing version, and upstream evidence.
- Metering must be durable before billing.
- All webhooks and reconciliation jobs are idempotent.
- A sandbox may be terminated at a spend limit, but the decision and resulting race conditions must be auditable.

### Security

- Never log API keys, provider credentials, secret values, signed access URLs, or raw authorization headers.
- Encrypt provider and customer secrets at rest using envelope encryption or a managed secret service.
- Do not store recoverable plaintext credentials in the database.
- Scope API keys to an organization/project and supported actions.
- Apply finite default lifetimes, idle timeouts, concurrency limits, and spend limits.
- Treat sandbox output, filenames, archives, environment values, provider errors, and webhook bodies as untrusted input.
- Prevent path traversal in file APIs.
- Bound file size, stream size, process output, request body, and execution duration.
- Outbound-network restrictions requested by the customer must fail closed.
- Public port endpoints must be scoped, expiring, revocable, and safe against confused-deputy access.
- Record security-sensitive operations in an append-only audit log.
- Do not enable unrestricted public signup before abuse controls and quotas pass their milestone gate.

### Reliability

- All external calls have explicit deadlines.
- Retries use bounded exponential backoff with jitter and respect idempotency.
- Provider errors map to stable Metal error codes while preserving safe diagnostic context.
- Unknown provider outcomes enter reconciliation; they are not labeled success or failure prematurely.
- Cleanup is durable and retryable.
- Health calculations distinguish Metal failures from provider failures and customer workload failures.

## Engineering conventions

Unless the repository already contains an approved alternative, use:

- TypeScript with strict compiler settings
- Node.js active LTS
- pnpm workspaces
- PostgreSQL as the durable source of truth
- Drizzle ORM with reviewed SQL migrations
- Zod for runtime boundary validation and JSON Schema generation where appropriate
- Structured JSON logging with request, project, sandbox, provider, and attempt identifiers
- OpenTelemetry-compatible traces and metrics
- Vitest for unit and integration tests
- Testcontainers or an equivalent real PostgreSQL test environment

The intended repository shape is:

```text
apps/
  api/
  worker/
  web/
packages/
  contracts/
  db/
  provider-core/
  provider-e2b/
  provider-daytona/
  provider-modal/
  router/
  billing/
  sdk-typescript/
  testkit/
```

Do not introduce Redis, Kafka, Kubernetes, Temporal, or a separate microservice unless a measured requirement in the active milestone demands it. PostgreSQL-backed jobs and outbox processing are the default.

## API conventions

- Version external routes under `/v1`.
- Use opaque Metal IDs.
- Validate requests and responses at service boundaries.
- Use a stable structured error envelope containing `code`, `message`, `request_id`, and optional safe `details`.
- Accept `Idempotency-Key` for provision and other retry-sensitive operations.
- Paginate list endpoints with opaque cursors.
- Stream command events with explicit sequence numbers so reconnects can resume safely where supported.
- Never expose provider credentials or internal raw provider responses.
- Use explicit units in field names: `timeout_seconds`, `memory_mb`, `amount_microusd`.
- Version capability and pricing records used for a routing decision.

## Provider adapter rules

Every adapter implements the same conformance contract and declares its capabilities separately.

The portable adapter surface includes:

- Discover declared capabilities
- Quote or estimate a request
- Create and inspect a sandbox
- Execute and stream a process
- Perform portable filesystem operations
- Expose and revoke an HTTP port
- Destroy a sandbox
- Fetch or derive billable usage
- Reconcile an operation with an unknown result

For every adapter:

- Pin and record the provider SDK/API version.
- Map provider states into documented Metal states.
- Normalize units without losing the original value.
- Implement deadlines and cancellation.
- Classify errors as retryable, terminal, capacity, auth, quota, policy, invalid request, or unknown.
- Provide contract tests using a fake transport.
- Provide opt-in live tests against a real provider account.
- Verify cleanup after both successful and failed tests.

Do not make the shared interface mirror whichever provider was integrated first.

## Database and migration rules

- Migrations are append-only after merge.
- Every foreign key, uniqueness constraint, and monetary invariant that can be enforced in PostgreSQL should be enforced there.
- Timestamps are UTC and database-generated where ordering matters.
- State transitions use compare-and-set semantics or row locking to prevent invalid concurrent transitions.
- Append-only event tables deny update/delete through application code.
- Schema changes include forward migration, tests, and a documented rollback or roll-forward strategy.

Never delete or rewrite user data to make a migration easier.

## Testing requirements

The test pyramid must include:

1. Unit tests for parsing, normalization, scoring, state transitions, and accounting.
2. Provider contract tests shared by all adapters.
3. Database integration tests using real PostgreSQL.
4. API integration tests covering authentication, authorization, idempotency, limits, and error envelopes.
5. Opt-in live provider smoke tests.
6. End-to-end tests that provision, execute, transfer a file, expose a port where supported, and destroy.
7. Failure-injection tests for timeouts, partial provision, duplicate delivery, unknown outcome, provider outage, and cleanup.
8. Reconciliation tests proving customer ledger, Metal usage, and provider usage can agree exactly.

Tests must not depend on test order. Live tests must tag resources and clean them up even when assertions fail.

## Documentation requirements

Every public behavior added in a milestone includes:

- API/SDK reference
- One minimal runnable example
- Capability limitations
- Stable error codes
- Billing behavior where relevant
- Security implications where relevant

Examples must use the public SDK and must run in CI against a fake provider or an explicitly configured live test environment.

## Change discipline

- Preserve unrelated user changes.
- Keep commits and patches scoped to the active milestone.
- Add dependencies only when their role is clear and justified.
- Do not disable linters, strictness, security checks, or tests to make a gate pass.
- Do not claim performance, security, cost savings, or portability without reproducible evidence.
- Update `BUILD_PLAN.md` only with actual verified status, not anticipated progress.

## Milestone completion report

At the end of each milestone, provide:

```md
## Milestone N completion

### Delivered

- ...

### Verification

- `command` -> result

### Evidence

- Test counts, live resource IDs with secrets removed, measured timings, or reconciliation totals

### Known limitations

- ...

### Exit gate

- PASS or FAIL, with reason
```

If the exit gate is `FAIL`, fix the milestone or stop. Do not advance.
