# Superagent Metal MVP Build Plan

## Purpose

This plan turns `VISION.md` into a sequence of independently verifiable milestones. Each milestone ends with an exit gate. Agents must follow `AGENT.md` and may not start the next milestone until the current gate passes.

## MVP outcome

At the end of the plan, a private-beta customer can:

1. Create a Metal account and project.
2. Fund or receive a controlled credit balance.
3. Use one Metal API key and TypeScript SDK.
4. Request a CPU Linux sandbox by capability.
5. Let Metal choose among E2B, Daytona, and Modal.
6. Run commands, stream output, transfer files, and expose an HTTP port.
7. Receive automatic fallback when provisioning fails safely.
8. Inspect routing, usage, costs, and audit history.
9. Destroy the sandbox or rely on enforced idle/runtime/spend limits.
10. Reconcile Metal charges with recorded provider usage.

## Fixed technical decisions

- TypeScript strict monorepo on Node.js active LTS
- pnpm workspaces
- PostgreSQL and Drizzle ORM
- HTTP JSON API under `/v1`
- PostgreSQL-backed durable jobs and transactional outbox
- Zod contracts shared by API and SDK
- Append-only usage, routing-attempt, audit, and ledger records
- Exact monetary storage in integer micro-USD or exact decimal values, never floating point
- Opaque Metal IDs distinct from provider resource IDs
- Structured logs, metrics, and traces from the first hosted milestone
- Managed Metal credentials and balance as the target product; BYOK may be added later as an option

Any change to a fixed decision requires an explicit architecture decision record explaining the evidence and consequences.

## State model

The sandbox lifecycle must represent uncertainty rather than compressing it into success/failure:

```text
requested
  -> routing
  -> provisioning
  -> ready
  -> stopping
  -> stopped

provisioning -> provision_unknown -> ready | cleanup_pending | failed
provisioning -> failed
ready -> runtime_unknown -> ready | cleanup_pending | failed
any nonterminal state -> cleanup_pending -> stopped | cleanup_failed
```

State transitions must be validated centrally and enforced atomically.

## Portable v1 contract

The contract must cover:

- Sandbox requirements and constraints
- Capability discovery and evidence level
- Normalized quote and pricing version
- Lifecycle and state
- Process execution and ordered stream events
- Filesystem operations
- Secrets and environment references
- HTTP port exposure/revocation
- Usage intervals and monetary amounts
- Routing policy, candidates, exclusions, selection, and fallback attempts
- Stable errors and retryability

Provider-specific extensions must not appear in the portable contract.

---

## Milestone 0: Repository foundation and executable contracts

### Objective

Create a clean, reproducible monorepo and freeze the first portable domain contract before integrating a provider.

### Deliverables

- pnpm workspace with the repository structure defined in `AGENT.md`
- Strict TypeScript configuration, linting, formatting, unit tests, and CI
- `packages/contracts` containing versioned Zod schemas and TypeScript types
- Stable Metal error codes and error envelope
- Sandbox state machine with exhaustive transition tests
- Capability model with `verified`, `provider_reported`, and `unknown` evidence
- Resource units and exact money helpers
- OpenAPI generation from validated contracts
- Architecture decision records for API transport, command streaming, money representation, and durable jobs
- A deterministic in-memory fake provider in `packages/testkit`

### Required verification

- Clean install from an empty dependency cache
- Typecheck, lint, format check, unit tests, and production build pass
- Contract JSON round-trip/property tests pass
- Invalid lifecycle transitions are rejected exhaustively
- Generated OpenAPI validates and has no undocumented public route shapes
- Money tests cover rounding boundaries and prove no binary floating-point path exists

### Exit gate

A consumer can compile against the portable contracts and run a complete create/execute/file/destroy flow against the deterministic fake provider. CI reproduces the result from a clean checkout.

---

## Milestone 1: Provider core and conformance harness

### Objective

Define an honest provider boundary and prove that adapters can be tested without changing core behavior.

### Deliverables

- `SandboxProvider` interface with lifecycle, exec, files, port exposure, usage, and reconciliation methods
- Provider capability declaration and quote interfaces
- Deadline, cancellation, retry classification, and normalized-error utilities
- Provider operation-attempt model with opaque attempt IDs
- Shared adapter conformance suite
- Failure-injectable fake transport supporting timeout, quota, capacity, auth, partial provision, unknown result, dropped stream, and cleanup failure
- Provider extension mechanism that cannot contaminate portable types

### Required verification

- Fake adapter passes every shared conformance test
- Each error class maps to a stable Metal error and retryability decision
- Unknown provision result enters reconciliation without creating a second untracked resource
- Destroy is idempotent under duplicate calls and duplicate completion events
- Stream events have stable ordering and bounded buffering
- Capability failure rejects before provider creation is invoked

### Exit gate

A second synthetic adapter with intentionally different provider semantics can pass the same contract suite without adding provider-specific behavior to the portable API.

---

## Milestone 2: E2B and Daytona vertical slice

### Objective

Prove the portable contract against two real providers with materially different implementations.

### Deliverables

- E2B adapter
- Daytona adapter
- SDK/API version pins and capability declarations for both
- Normalized create, inspect, command streaming, filesystem, port exposure where supported, and destroy behavior
- Provider-specific quote estimation with original and normalized units retained
- Opt-in live test runner with tagged resources and guaranteed cleanup
- Capability comparison document generated from adapter declarations

### Required verification

For each provider, live tests must:

1. Create a sandbox with a deadline.
2. Confirm requested CPU/memory/image constraints where observable.
3. Upload and read back a binary and text fixture.
4. Execute a command and verify stdout, stderr, exit code, timeout, and cancellation.
5. Start an HTTP server and verify a scoped endpoint where the provider supports it.
6. Destroy the sandbox twice without error.
7. Confirm no tagged live resource remains.

Also verify:

- The same public test program runs unchanged against both providers.
- Unsupported hard capabilities fail before provisioning.
- Provider auth, quota, timeout, and capacity errors are distinguishable.
- Actual provider identifiers and secret URLs do not leak through public objects or logs.

### Exit gate

One unchanged portable program completes the full supported lifecycle on both E2B and Daytona, and forced failures leave no untracked resources.

---

## Milestone 3: Hosted control plane

### Objective

Expose the provider-independent lifecycle through an authenticated, multi-tenant Metal API backed by durable state.

### Deliverables

- Organizations, users/service principals, projects, roles, and scoped API keys
- Hashed API-key storage and rotation/revocation
- Durable sandbox, provider-attempt, process, endpoint, and audit records
- `/v1/sandboxes` create/get/list/destroy endpoints
- Command execution and reconnectable ordered event streaming
- Filesystem and endpoint routes for the portable core
- Idempotency-key storage and response replay for create
- Transactional outbox and worker for provision, cleanup, reconciliation, and expiry
- Default runtime, idle, concurrency, request-size, output-size, and file-size limits
- Structured logs, request IDs, traces, and baseline service metrics

### Required verification

- Real PostgreSQL integration tests cover every valid and invalid state transition
- Tenant isolation tests prove cross-project reads and writes are impossible
- Duplicate create requests with the same idempotency key create one Metal sandbox and at most one live provider resource
- Worker crash/restart tests resume safely from the outbox
- Partial provision and unknown outcomes enter reconciliation and cleanup
- Expired and idle sandboxes are destroyed durably
- Revoked API keys stop working immediately within the documented cache bound
- Logs and traces pass automated secret-redaction tests
- Rate, concurrency, and size limits fail with stable errors

### Exit gate

Two isolated test organizations can concurrently use the hosted API against the fake and real adapters without state leakage, duplicate resources, lost cleanup, or secret exposure.

---

## Milestone 4: Capability catalog, quotes, and deterministic routing

### Objective

Choose providers from declared requirements using explainable, versioned data.

### Deliverables

- Versioned provider capability catalog by provider, region, and workload class
- Normalized pricing catalog with effective times and original source evidence
- Health observations for create success, time-to-ready, and Metal-attributable versus provider-attributable failures
- Eligibility engine for hard constraints
- Deterministic implementations of `cheapest`, `fastest`, `reliable`, and `balanced`
- Explicit-provider override with capability validation
- Persisted routing decision containing candidates, exclusions, observations, quotes, scores, selection, and policy version
- Dry-run quote/routing endpoint that does not provision

### Initial balanced policy

Begin with a documented normalized score:

- Estimated price: 35%
- Expected time-to-ready: 30%
- Recent provisioning reliability: 25%
- Regional preference/latency: 10%

Weights are versioned configuration, not hidden constants. Missing observations must use a documented conservative prior.

### Required verification

- Golden tests cover every hard constraint and routing policy
- Identical inputs and catalog versions always yield the same decision
- Security constraints such as isolation never become score tradeoffs
- Stale, unknown, and contradictory capability records fail safely
- Price normalization tests cover per-second, per-minute, fixed, and minimum-duration pricing
- Routing records reproduce the original choice offline
- Synthetic provider degradation changes future selections within the documented window
- Customer workload failures do not incorrectly damage provider provisioning health

### Exit gate

Given a fixed catalog and observation dataset, Metal can reproduce and explain every routing decision exactly, and never selects a provider that violates a hard requirement.

---

## Milestone 5: Modal adapter and provisioning fallback

### Objective

Add a third provider and safely rescue failed creation requests.

### Deliverables

- Modal adapter passing the shared conformance suite
- Modal live tests matching Milestone 2 where capabilities permit
- Ordered fallback plan generated from eligible ranked candidates
- Per-attempt deadlines and overall request deadline
- Attempt and cleanup records for every provider contacted
- Fallback policy for retryable capacity, provider availability, and deadline failures
- Explicit rules forbidding fallback on invalid requests, auth failures attributable to Metal configuration, unsupported hard requirements, or customer cancellation
- Customer-visible routing/fallback summary with safe diagnostics

### Required verification

- Same portable program runs on E2B, Daytona, and Modal
- Forced first-provider capacity failure falls back and succeeds on the next eligible provider
- Timeout with unknown provider outcome triggers reconciliation before any unsafe duplicate action
- Overall deadline caps the full fallback sequence
- All failed attempts are eventually confirmed absent or destroyed
- Non-retryable failures never fan out across providers
- A started sandbox is never represented as having migrated providers
- Concurrency races between late success and fallback are resolved without leaking two billable sandboxes

### Exit gate

Failure injection demonstrates that fallback increases successful provisioning without duplicate live resources, hidden charges, or false live-migration semantics.

---

## Milestone 6: Metering, ledger, credits, and reconciliation

### Objective

Charge customers from durable, auditable usage and reconcile exactly with upstream cost.

### Deliverables

- Immutable raw provider-usage events
- Normalized usage intervals and dimensions
- Versioned upstream and customer pricing records
- Double-entry ledger for deposits, holds, charges, releases, refunds, adjustments, and provider cost
- Pre-provision balance/concurrency authorization and optional estimated-cost hold
- Runtime spend-limit enforcement and termination workflow
- Provider invoice/usage reconciliation jobs
- Customer usage and ledger APIs
- Controlled administrative credit grant for private beta
- Payment funding integration only after legal/provider-account review approves the model

### Required verification

- Ledger transactions balance for all generated scenarios
- Property tests cover duplicate events, out-of-order events, corrections, partial intervals, rounding boundaries, and cancellation races
- A provider event can be ingested repeatedly without duplicate charge
- Quote, hold, actual charge, release, refund, and adjustment remain separately auditable
- Customer balance never becomes inconsistent under concurrent sandbox creation
- Spend-limit termination is tested against metering delay and late provider usage
- Reconciliation reports exact agreement or explicit categorized variance; it never silently absorbs differences
- Upstream usage can be traced to a Metal sandbox and customer charge without exposing provider credentials

### Exit gate

A multi-day synthetic and live-provider run reconciles customer ledger, Metal usage, and upstream provider records exactly or produces fully explained variance entries. No floating-point money enters storage or calculation.

---

## Milestone 7: TypeScript SDK and operational dashboard

### Objective

Make the complete routed sandbox lifecycle easy to adopt and inspect.

### Deliverables

- `@openmetal/sdk` with create, connect, lifecycle, commands, files, endpoints, and usage APIs
- Typed async iteration for command streams
- Automatic safe retries for idempotent requests only
- Runnable migration examples from direct E2B and Daytona usage
- Minimal dashboard for projects, API keys, active sandboxes, routing decisions, fallbacks, usage, ledger, limits, and audit events
- Provider status view based on Metal observations
- Documentation for capability limitations, stable errors, billing, and security behavior

### Required verification

- Published-package dry run installs into an empty example application
- Examples compile and run against the fake environment in CI
- One example runs unchanged across all three live providers through routing
- SDK reconnect behavior does not duplicate command execution
- Dashboard tenant-isolation and sensitive-data tests pass
- Accessibility and basic responsive-layout checks pass
- A direct-provider sample can migrate by replacing credentials/imports and removing provider-selection code, without changing the workload flow

### Exit gate

A new developer can fund a test project, copy a documented example, create a routed sandbox, run a command, inspect why it was routed, see the final charge, and clean up without provider credentials.

---

## Milestone 8: Private beta hardening and evidence

### Objective

Operate Metal safely for 5–10 design partners and prove that routing creates measurable value.

### Deliverables

- Invite-only onboarding
- Abuse prevention, quotas, anomaly alerts, emergency provider/project disable controls, and incident runbooks
- SLOs and alerts for API availability, provisioning success, time-to-ready, cleanup backlog, reconciliation lag, and ledger invariants
- Backup/restore and disaster-recovery verification
- Provider credential rotation runbook
- Data retention and deletion behavior
- Benchmark harness using representative coding-agent workloads and fixed images
- Customer cohort report comparing routed Metal outcomes with pinned-provider baselines
- Provider terms/reseller and payment-flow review completed before broad managed-billing availability

### Required verification

- Load test at 2x expected beta concurrency without violating limits or losing events
- Chaos tests cover API restart, worker restart, database failover simulation, provider outage, delayed webhook/usage, and cleanup backlog
- Restore from backup into an isolated environment and reconcile counts and ledger totals
- Credential rotation occurs without customer-visible secret leakage
- Incident drill can disable one provider and reroute new eligible requests
- At least 100 representative creation attempts produce reproducible startup, reliability, fallback, and cost evidence
- No benchmark claim is published without methodology and raw aggregate evidence

### Exit gate

At least five external teams complete production-like workloads. Metal demonstrates either at least 15% lower effective cost or a material improvement in successful time-to-ready for a defined segment, fallback rescues real requests, and all beta usage reconciles.

---

## Post-MVP candidates

These are intentionally unplanned until the private-beta gate passes:

- Python SDK
- BYOK enterprise routing
- Desktop/computer-use sandboxes
- Portable filesystem checkpoints
- Persistent workspaces and volumes
- Cloud GPU instance discovery, provisioning, and routing across GPU clouds
- GPU-specific images, drivers, topology, storage, networking, interruption, and pricing contracts
- Batch jobs and fleets
- Reserved and spot capacity
- Provider self-service onboarding
- Public marketplace and dynamic bids

## Definition of MVP complete

The MVP is complete only when all milestone exit gates pass and the private-beta evidence supports the product thesis. Code completion alone is insufficient.
