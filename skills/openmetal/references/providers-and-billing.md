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
| Modal       | Environment, OCI image         | No                                              | No     | No                                       |
| Northflank  | Environment, OCI image         | Yes                                             | Yes    | Yes                                      |
| Runloop     | Environment, provider template | Yes                                             | Yes    | Yes                                      |
| Vercel      | Environment, OCI image         | No                                              | No     | Yes                                      |

This matrix describes current adapters, not future vision documents. If reliable pause/resume is required, use CodeSandbox, E2B, Northflank, or Runloop. The API currently attempts Daytona pause even though the adapter advertises pause as disabled by default, and BYOK configuration cannot enable that capability flag. Treat Daytona pause as inconsistent until the implementation is corrected.

Managed routing skips providers without durable cost evidence. Modal therefore requires BYOK in current routing. Cloudflare managed eligibility requires both account identification and analytics cost access.

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
