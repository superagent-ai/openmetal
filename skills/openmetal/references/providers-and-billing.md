# Providers, BYOK, And Billing

Read this reference before choosing a provider, requiring pause/resume, configuring provider credentials, or diagnosing credit and eligibility errors.

## Provider Capabilities

| Provider    | Supported sources              | Pause                                           | Resume | Managed cost evidence                    |
| ----------- | ------------------------------ | ----------------------------------------------- | ------ | ---------------------------------------- |
| Blaxel      | Environment, OCI image         | No                                              | No     | Yes                                      |
| Cloudflare  | Environment                    | No                                              | No     | Only with account ID and analytics token |
| CodeSandbox | Environment, provider template | Yes                                             | Yes    | Yes                                      |
| Daytona     | Environment, OCI image         | Attempted; capability reporting is inconsistent | No     | Yes                                      |
| E2B         | Environment, provider template | Yes                                             | Yes    | Yes                                      |
| Freestyle   | Environment, provider template | Yes                                             | Yes    | Estimated rate card (low confidence)     |
| Modal       | Environment, OCI image         | No                                              | No     | Metered resource usage with rate card    |
| Northflank  | Environment, OCI image         | Yes                                             | Yes    | Yes                                      |
| Runloop     | Environment, provider template | Yes                                             | Yes    | Yes                                      |
| Vercel      | Environment, OCI image         | No                                              | No     | Yes                                      |

This matrix describes current adapters, not future vision documents. If reliable pause/resume is required, use CodeSandbox, E2B, Northflank, or Runloop. The API currently attempts Daytona pause even though the adapter advertises pause as disabled by default, and BYOK configuration cannot enable that capability flag. Treat Daytona pause as inconsistent until the implementation is corrected.

Managed routing skips providers without durable cost evidence. Modal is eligible using cumulative
billable CPU and memory usage from its sandbox resource API with a versioned published rate card.
Cloudflare managed eligibility requires both account identification and analytics cost access.

## Runtime Capabilities

The worker accepts any adapter that implements process execution. Adapters with `streams: false` remain usable through the public process API, but their output appears only after command completion and does not preserve cross-stream timing.

| Provider    | Public process API               | Filesystem API            | Leased HTTP endpoints |
| ----------- | -------------------------------- | ------------------------- | --------------------- |
| Blaxel      | Execute; buffered output         | Read, write, list, delete | Create and revoke     |
| Cloudflare  | Execute and stream; no cancel    | Read and write            | No                    |
| CodeSandbox | No                               | No                        | No                    |
| Daytona     | Execute; buffered output; cancel | Read, write, list, delete | No                    |
| E2B         | Execute and stream; no cancel    | Read, write, list, delete | No                    |
| Freestyle   | Execute; buffered output         | Read, write, list, delete | No                    |
| Modal       | Execute and stream; no cancel    | Read, write, list, delete | No                    |
| Northflank  | No                               | No                        | No                    |
| Runloop     | Execute; buffered output         | Read and write            | No                    |
| Vercel      | Execute and stream; no cancel    | Read and write            | No                    |

Global contract ceilings are 100 MiB process output, 10 MiB per file read/write, 10,000 list entries, and 86,400-second endpoint leases. Current adapter ceilings are:

- Blaxel: 10 MiB output, 10 MiB file read/write, 10,000 list entries.
- Cloudflare: 10 MiB output and 10 MiB file read/write.
- Daytona, E2B, and Modal: 100 MiB output, 10 MiB file read/write, 10,000 list entries.
- Freestyle: 10 MiB output, 10 MiB file read/write, 10,000 list entries.
- Runloop and Vercel: 10 MiB output and 10 MiB file read/write.
- Endpoint-capable adapters advertise at most 86,400 seconds.

Provider-specific runtime limitations:

- Blaxel, Daytona, Freestyle, and Runloop return buffered process output. Commands execute through the public process API, but stdout/stderr events become available only after completion and their sequence does not reconstruct cross-stream timing. Daytona starts commands asynchronously and confirms cancellation by deleting the command's temporary session.
- Cloudflare supports ordered process execution with an omitted or empty environment, but rejects non-empty environment overrides. It has no process cancellation.
- E2B, Modal, and Vercel stream output but do not advertise confirmed process cancellation. Runloop supports provider-level cancellation even though its output is buffered.
- Daytona, E2B, and Modal reject append writes. Runloop and Vercel also reject append; Runloop rejects `create_parents: true`.
- Daytona applies an OCI image as a declarative `FROM <image>` build and waits until the sandbox state is `started`. Omitted `disk_mb` is sent as 16 GiB because Daytona's own default disk is 3 GiB.
- Daytona sandboxes are created with Daytona's idle auto-stop disabled, so detached background processes keep running until the Metal runtime timeout. Daytona also receives a wall-clock TTL of the runtime timeout plus the image build window and 15 minutes, as a backstop if Metal's own destroy fails.
- Daytona runtime failures carry Daytona's error code and message, for example `SANDBOX_NOT_RUNNING` or `SANDBOX_NOT_FOUND`, in the process or runtime-operation `error.message`.
- Modal managed cost uses cumulative CPU core nanoseconds and memory GiB nanoseconds from the
  sandbox resource API. Metal applies the published Sandbox rate card with medium confidence and
  retains a final usage measurement before termination. Credits, discounts, and regional modifiers
  are excluded.
- Blaxel and Cloudflare implement append by reading and rewriting the whole file, so the resulting file must still fit their 10 MiB adapter limit.
- Cloudflare file paths must be within `/workspace`; it does not implement list or delete. Runloop and Vercel do not implement list or delete and require a file path rather than `/`.
- Vercel file writes are additionally constrained by USTAR path-component limits.
- Freestyle uses buffered native execution with a 300-second provider timeout ceiling. It supports atomic overwrite writes but not portable create-only or append modes. Its managed cost is a low-confidence cumulative rate-card estimate from provider runtime counters and fixed resources; it excludes transfer, plan credits, discounts, and enterprise pricing.
- Only Blaxel exposes portable HTTP endpoints with a live-verified native expiry and revocation path. All other adapters keep the endpoint capability disabled when the upstream API cannot satisfy or live verification cannot prove the complete lease contract.

Capability checks happen in the worker after the API accepts a process, filesystem operation, or endpoint. Always inspect the terminal resource and its `error`; HTTP 202 is not capability confirmation.

## Routing And Fallback

With `provider: "auto"` or no provider:

1. Explicit `fallback.providers` are candidates in the caller's order.
2. Other configured managed or BYOK providers follow in registry order.
3. `fallback.max_attempts` truncates the candidate list.

With an explicit provider:

1. The explicit provider is primary.
2. Listed fallback providers follow in order.
3. Candidates must be unique.

Current routing does not implement `cheapest`, `fastest`, `reliable`, or `balanced` ranking. Do not describe automatic selection as price- or performance-optimized.

Fallback is safe only when the failure establishes that another attempt will not duplicate a live sandbox. Capacity, unavailable, and known-absent timeout failures may fall back. Unknown outcomes enter reconciliation first. Auth, invalid-request, unsupported, and customer errors do not safely fan out.

## Managed Billing

Each new user receives a one-time USD 500.00 grant in the first organization they create. Additional
organizations do not receive the grant. Welcome grants have no purchase fee.

Managed sandbox creation requires the organization to have a credit balance greater than zero. There is no estimated hold, so delayed metering can temporarily make a balance negative. When a durable charge leaves the balance at or below zero and no automatic top-up is active, OpenMetal schedules managed sandboxes to stop. If automatic top-up is active but its infrastructure fails terminally, current code may not schedule spend-limit enforcement; do not treat the balance guard as an unconditional termination guarantee.

Managed usage is charged from durable provider cost evidence. The purchase fee is 5.5 percent of the credit amount with a minimum fee of USD 0.80. Never calculate money with binary floating point in OpenMetal integrations.

Use the CLI to inspect billing:

```bash
openmetal billing show --organization <organization-id>
openmetal billing quote --organization <organization-id> --amount-usd 20.00
```

## BYOK Behavior

BYOK credentials belong to an organization, are encrypted in Supabase Vault, and are never returned by API responses. BYOK sandboxes are paid directly through the customer's provider account, are not charged against OpenMetal credits, and are not stopped by the managed spend-limit path.

A single explicitly selected BYOK provider without fallback can create without a positive managed balance. Every automatic request and every request with any fallback requires positive OpenMetal credit, even when all candidates have BYOK credentials.

Removing a provider credential disables it for new routing. OpenMetal retains the encrypted credential as needed to manage existing sandboxes.

## Credential Input Shapes

Configure credentials with a user-session client or `openmetal provider-credential set`. Never commit these JSON objects.

Blaxel:

```json
{
  "provider": "blaxel",
  "api_key": "<secret>",
  "workspace": "<workspace>",
  "account_id": "<optional-account-id>"
}
```

Cloudflare:

```json
{
  "provider": "cloudflare",
  "api_url": "https://sandbox-bridge.example.com",
  "api_key": "<secret>",
  "account_id": "<optional-account-id>",
  "analytics_token": "<optional-secret>"
}
```

CodeSandbox:

```json
{
  "provider": "codesandbox",
  "api_key": "<secret>",
  "workspace_id": "<optional-workspace-id>"
}
```

Daytona:

```json
{
  "provider": "daytona",
  "api_key": "<secret>",
  "organization_id": "<optional-organization-id>",
  "target": "<optional-target>"
}
```

E2B:

```json
{
  "provider": "e2b",
  "api_key": "<secret>"
}
```

Freestyle:

```json
{
  "provider": "freestyle",
  "api_key": "<secret>"
}
```

Modal:

```json
{
  "provider": "modal",
  "token_id": "<secret>",
  "token_secret": "<secret>",
  "environment": "<optional-environment>"
}
```

Northflank:

```json
{
  "provider": "northflank",
  "api_token": "<secret>",
  "project_id": "<provider-project-id>",
  "team_id": "<optional-team-id>"
}
```

Runloop:

```json
{
  "provider": "runloop",
  "api_key": "<secret>"
}
```

Vercel:

```json
{
  "provider": "vercel",
  "token": "<secret>",
  "project_id": "<provider-project-id>",
  "team_id": "<optional-team-id>"
}
```

Provider credentials and project API keys are unrelated. Provider credentials let OpenMetal provision through an upstream customer account; `metal_sk_` keys authenticate the customer to OpenMetal sandbox routes.
