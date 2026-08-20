# Metal Vision

## Status

This document defines the product direction for Metal. The name is provisional; the product thesis is not.

## One-line vision

Metal is the universal compute gateway for AI agents: one API key, one balance, and one capability-based interface for giving an agent a computer.

## Starting point

Metal starts with secure, ephemeral CPU sandboxes used by coding agents and code-execution products. It expands later into GPU sandboxes, browser computers, persistent machines, and other programmable compute.

The first release is not a general-purpose cloud, a new sandbox runtime, or a thin compatibility library. It is a hosted control plane that brokers existing compute providers.

## The problem

AI applications increasingly need computers, not just models. Coding agents clone repositories, install dependencies, run tests, expose preview ports, manipulate files, and execute untrusted code. Today, developers must choose and integrate a sandbox provider directly.

That creates recurring work:

- Every provider has a different SDK, lifecycle, filesystem model, pricing model, capability set, and failure mode.
- Availability and startup latency vary by provider, region, image, and time.
- Customers maintain multiple accounts, credentials, balances, contracts, and dashboards.
- Provider selection is hard-coded before actual price, health, or capacity is known.
- Switching providers requires application changes and operational revalidation.
- Agents cannot express the computer they need and let infrastructure choose where it should run.

Model access had the same shape before routing layers normalized discovery, access, billing, and fallback. Compute needs an equivalent layer, adapted to the fact that computers are stateful.

## Product promise

> Give your agent a computer with one API. Metal finds suitable capacity, starts it, meters it, and bills it in one place.

A developer describes requirements and an optimization goal:

```ts
const sandbox = await metal.sandboxes.create({
  image: "node:22",
  resources: {
    cpu: 2,
    memoryMb: 4096,
    diskMb: 10240,
  },
  constraints: {
    regions: ["eu-north", "eu-west"],
    isolation: ["microvm", "vm"],
    maxHourlyPriceUsd: "0.20",
  },
  routing: "balanced",
  timeoutSeconds: 1800,
});
```

Metal selects an eligible provider, provisions the sandbox, and returns the same interface regardless of where it runs.

## Initial customer

The first customer is a team building or operating:

- Coding agents
- Code interpreters
- Automated software evaluation
- Security scanning in isolated environments
- CI-like agent workflows
- Products that execute user- or model-generated code

The initial buyer is a technical founder or infrastructure engineer who already uses at least one sandbox provider and expects to need another.

## The durable abstraction

Metal routes capabilities, not brand names. The customer should usually describe the required machine rather than select a provider.

The portable v1 capability set is deliberately small:

1. Create, inspect, list, connect to, and destroy a sandbox.
2. Run a process and stream stdin, stdout, stderr, exit status, and timing.
3. Read, write, upload, download, list, and delete files.
4. Set environment variables and inject secrets without returning secret values.
5. Allow or restrict outbound networking.
6. Expose an HTTP port through a time-limited endpoint.
7. Apply runtime, idle, concurrency, and spending limits.
8. Attach project, customer, agent, and run metadata.

Capabilities that cannot be normalized honestly are exposed through capability discovery or provider-specific extensions. Metal must never silently emulate a security or persistence guarantee that the selected provider does not offer.

## Routing semantics

Routing happens before provisioning. A request is handled in two phases:

1. Eligibility: reject providers that do not satisfy hard requirements.
2. Ranking: score eligible providers using the selected policy and current observations.

Initial routing policies:

- `cheapest`: minimize the estimated normalized cost.
- `fastest`: minimize expected time to ready.
- `reliable`: minimize recent provisioning failure probability.
- `balanced`: combine price, startup latency, reliability, and regional preference.

Provider health and performance must be measured for the actual operation, region, and workload class whenever possible. Marketing claims are not routing data.

Metal may retry provisioning on another eligible provider when creation fails or misses its startup deadline. Metal does not promise transparent migration after a sandbox has started. A running computer contains state; recovering it requires explicit checkpoint-and-replay semantics, which are outside v1.

Every routing decision must be explainable. Internally, and eventually to customers, Metal records:

- Providers considered
- Eligibility exclusions
- Quotes used
- Health observations used
- Selected provider and score
- Fallback attempts
- Actual startup time and cost

## What makes Metal more than an SDK

An SDK that maps several provider APIs into common method names is useful but insufficient. Metal's core value is hosted coordination:

- One Metal API surface, with keys scoped to projects
- One prepaid balance or contract
- Normalized, auditable usage
- Current price and capability discovery
- Health-aware routing
- Automatic provisioning fallback
- Spend and concurrency controls
- Provider-independent observability
- Optional bring-your-own-provider credentials for enterprise customers

Managed billing is the default product. BYOK is an escape hatch, not the primary experience.

Managed capacity is also the default operating model. Metal maintains provider contracts and
credentials, provisions resources under Superagent-managed capacity, tags every resource to its
Metal organization and project, charges the customer through Metal, and reconciles upstream
provider invoices.

## Trust, security, and isolation

Metal brokers execution of untrusted code and therefore inherits serious security obligations.

Product invariants:

- Every sandbox belongs to exactly one project and principal.
- Provider credentials are never exposed to customers or sandbox workloads.
- Customer secrets are encrypted, redacted from logs, and never returned after creation.
- Provider capability claims distinguish verified, provider-reported, and unknown properties.
- Isolation type is a hard constraint, never a soft routing preference.
- Default sandbox lifetime, idle timeout, concurrency, and spend limits are finite.
- Destructive lifecycle operations are idempotent.
- Usage and billing events are append-only and reconcilable.
- Public endpoints are time-limited, scoped, revocable, and auditable.
- Outbound networking restrictions fail closed when requested.
- Abuse controls exist before unrestricted public signup.

Metal should eventually publish independent provider benchmarks and security verification, including startup reliability, isolation architecture, network-policy behavior, termination behavior, and cost accuracy.

## Business model

Customers fund one Metal balance. Metal pays upstream providers and charges a transparent service margin on managed usage. Enterprise customers may use contracted pricing, invoicing, or their own provider accounts while retaining routing and observability.

The business is not won through markup alone. Durable value comes from reducing operational work and improving placement quality. Over time, aggregate demand can support provider discounts and better capacity access.

## Data advantage

Every provision produces comparable operational data:

- Requested versus delivered resources
- Quote versus actual cost
- Time to ready
- Provisioning and runtime failure rates
- Image and dependency setup time
- Region and workload-specific performance
- Frequency and success of fallbacks
- Customer routing preferences

This data improves routing and becomes difficult for a single provider or local abstraction library to reproduce across the market.

## Product principles

### Requirements over providers

Users describe the computer they need. Explicit provider selection remains available for testing, compliance, and debugging.

### Honest portability

Normalize only semantics Metal can preserve. Expose capability differences instead of burying them.

### Stateful compute is not an LLM request

Provisioning can fail over. Running machines cannot be invisibly moved. Product language and implementation must respect that boundary.

### Safe defaults

Short lifetimes, idle shutdown, scoped secrets, spending caps, and restricted signup are default behavior.

### Measured routing

Use observed price, availability, startup time, and reliability. Store enough evidence to explain every selection.

### Provider neutrality

No provider-specific behavior may leak into the portable API without being explicitly named as an extension.

### Meter first, bill second

Usage must be durable, append-only, and reconcilable before it can affect a customer balance.

### Build the control plane, not the supply

The MVP integrates existing providers. Metal does not operate its own sandbox fleet.

## MVP boundaries

The MVP includes:

- TypeScript SDK and HTTPS API
- E2B, Daytona, Modal, Railway, and Vercel adapters
- CPU Linux sandboxes
- Lifecycle, command streaming, filesystem operations, environment/secrets, and HTTP port exposure
- Capability and normalized price catalog
- `cheapest`, `fastest`, `reliable`, and `balanced` routing
- Provisioning fallback
- Projects, API keys, usage, credits, limits, and audit logs
- Minimal operational dashboard

The MVP explicitly excludes:

- Metal-operated compute infrastructure
- Desktop or computer-use automation
- Cross-provider snapshots or live migration
- Persistent volumes
- SSH access
- Kubernetes and arbitrary cloud primitives
- Multi-node jobs or distributed training
- General GPU rental
- Spot-instance recovery
- Anonymous public access

## Expansion path

Metal expands by adding capabilities without replacing the request model:

1. CPU sandboxes for agents
2. GPU-enabled sandboxes for inference, evaluation, and fine-tuning jobs
3. Browser and desktop computers
4. Persistent workspaces and provider-portable checkpoints
5. Batch jobs and fleets
6. Reserved and spot capacity
7. A two-sided market where providers publish verifiable capacity and quotes

GPU support begins as a resource requirement, not a separate product API:

```ts
gpu: {
  count: 1,
  memoryMb: { min: 49152 },
  architectures: ["hopper", "ada"],
}
```

## Success criteria

The private beta is successful when:

- At least five external teams run production-like agent workloads through Metal.
- At least 30% of creations are routed to a provider the customer did not explicitly select.
- Metal reduces effective cost by at least 15% or materially improves successful time-to-ready for a meaningful workload segment.
- Provisioning fallback measurably rescues requests that otherwise would have failed.
- Customers use managed Metal credits rather than only BYOK.
- No customer needs provider-specific code for the portable v1 feature set.
- Usage can be reconciled exactly against upstream provider records and customer charges.

## North-star metric

Successful routed compute hours: sandbox runtime hours that satisfied the declared requirements, became ready within the deadline, completed without a Metal control-plane failure, and produced fully reconciled usage.

Supporting metrics:

- Successful time-to-ready
- Provisioning success rate
- Fallback rescue rate
- Normalized cost per successful compute hour
- Gross margin after upstream cost
- Percentage of requests using capability-based routing
- Number of active projects and retained weekly projects

## Final test

Metal is working when an agent developer can delete multiple provider integrations, retain or improve reliability and cost, and stop caring which provider ran each sandbox.
