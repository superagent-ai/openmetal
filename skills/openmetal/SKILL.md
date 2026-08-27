---
name: openmetal
description: Use this skill whenever a user wants to provision, configure, inspect, pause, resume, or destroy cloud sandboxes with OpenMetal; run processes, move or manage files, expose HTTP endpoints, or automate OpenMetal through its CLI or TypeScript SDK; configure projects, API keys, provider routing, fallback, resources, lifecycle, BYOK credentials, or billing; or diagnose OpenMetal operations and errors. Use it for Metal sandbox tasks even when the user does not explicitly ask for this skill.
compatibility: Requires network access and either the OpenMetal CLI or Node.js 22+ for the TypeScript SDK.
metadata:
  author: openmetal
  version: "1.0"
---

# OpenMetal

Use OpenMetal as a hosted control plane for creating and managing sandboxes across supported compute providers. Prefer portable OpenMetal configuration over direct provider APIs.

## Current Boundary

OpenMetal supports sandbox lifecycle; asynchronous argv-based processes with ordered persisted output; binary filesystem read, write, list, and delete; and leased HTTP endpoints. Read [references/runtime.md](references/runtime.md) for exact routes, SDK methods, CLI commands, limits, asynchronous behavior, and provider gating.

Interactive PTY/terminal sessions, streaming stdin, SSH, WebSocket, and general connection/session APIs remain unsupported. Do not invent methods such as `sandbox.exec()`, `sandbox.files`, `sandbox.connect()`, or `sandbox.ports`; the shipped SDK uses `processes`, `filesystem`, `runtimeOperations`, and `endpoints`.

Some accepted request fields are not fully enforced by current provider adapters. Read [references/sandbox-configuration.md](references/sandbox-configuration.md) before using advanced fields or making security claims.

Read the current implementation warnings in [references/operations-and-errors.md](references/operations-and-errors.md) before automating retries or interpreting asynchronous failures.

## Choose An Interface

- Use the CLI for interactive administration, shell scripts, CI jobs, and one-off sandbox operations. Read [references/cli.md](references/cli.md).
- Use `@openmetal/sdk` when integrating sandbox lifecycle or runtime operations into a TypeScript application. Read [references/sdk.md](references/sdk.md).
- Use the CLI for initial browser login, organization/project setup, project API-key creation, billing, and BYOK configuration unless the application already has a Supabase user session.

## Safe Workflow

1. Check prerequisites and whether credentials are configured without exposing their values.
2. Resolve the target API URL and project explicitly. For shell automation, use `OPENMETAL_API_URL`, `OPENMETAL_PROJECT_ID`, and `OPENMETAL_API_KEY`.
3. Run `openmetal doctor` when configuring a machine or diagnosing authentication.
4. Choose a short, explicit `runtime_timeout_seconds`; the normal default is 1800 seconds.
5. Prefer automatic provider selection unless the user requires a provider for testing, compliance, or a provider template.
6. Create the sandbox and retain both `sandbox.id` and `operation.id` from asynchronous responses.
7. Wait for the operation to reach `succeeded`, `failed`, or `cancelled`; do not treat HTTP 202 as a ready sandbox or completed runtime action.
8. Inspect the returned sandbox state before taking another lifecycle action.
9. Destroy temporary sandboxes when the task completes. Ask before destroying a sandbox the user may want to keep.

## Authentication Model

OpenMetal has two credential classes with different scopes:

- A Supabase user access token administers organizations, projects, project API keys, members, invitations, provider credentials, billing, and durable project events.
- A project API key beginning with `metal_sk_`, plus its `prj_` project ID, accesses sandbox routes. Operation get/event routes require the exact originating project key but do not require the project header.
- The same project key and project ID access processes, filesystem runtime operations, and leased endpoint routes for that project's ready sandboxes.

Never log, commit, or place either token in a sandbox request. Use environment variables or the CLI's protected credential store. Initial API-key creation necessarily returns the key once; have the user run that step in a trusted terminal whose output is not captured. Do not confuse a project API key with a provider BYOK credential.

## Create A Sandbox

Use common CLI flags for a basic portable sandbox:

```bash
openmetal sandbox create \
  --environment metal/node \
  --environment-version latest \
  --vcpu 2 \
  --memory-mb 4096 \
  --runtime-timeout 1800 \
  --async
```

For provider routing, fallback, network intent, metadata, or provider-specific options, create a complete request from [assets/sandbox.example.json](assets/sandbox.example.json):

```bash
openmetal --json --no-input sandbox create \
  --file sandbox.json \
  --async
```

In non-interactive output the CLI returns the accepted mutation immediately. Extract the operation ID and wait explicitly:

```bash
openmetal --json --no-input operation wait <operation-id> --timeout 180
```

## Manage Sandboxes

```bash
openmetal --json --no-input sandbox list
openmetal --json --no-input sandbox get <sandbox-id>
openmetal --json --no-input sandbox pause <sandbox-id> --async
openmetal --json --no-input sandbox resume <sandbox-id> --async
openmetal --json --no-input --yes sandbox delete <sandbox-id> --async
```

Pause and resume are provider-dependent. Read [references/providers-and-billing.md](references/providers-and-billing.md) before requiring them.

## Use Sandbox Runtime

Use the exact CLI groups:

```bash
openmetal sandbox exec <sandbox-id> -- node app.js
openmetal process get <sandbox-id> <process-id>
openmetal file upload <sandbox-id> ./input.bin /workspace/input.bin
openmetal file download <sandbox-id> /workspace/output.bin ./output.bin
openmetal file list <sandbox-id> /workspace
openmetal --yes file delete <sandbox-id> /workspace/input.bin
openmetal endpoint expose <sandbox-id> --port 8080 --lease-seconds 3600
openmetal endpoint list <sandbox-id>
openmetal --yes endpoint revoke <sandbox-id> <endpoint-id>
```

Processes, filesystem operations, and endpoint provisioning are asynchronous. The high-level CLI waits for processes and filesystem results, while endpoint exposure returns the initial `provisioning` representation. Provider capabilities differ and are checked after acceptance. Read [references/runtime.md](references/runtime.md) and [references/providers-and-billing.md](references/providers-and-billing.md) before choosing a provider or relying on cancellation, append, list/delete, parent creation, or endpoint revocation.

## Operations And Failures

Provisioning and lifecycle changes are asynchronous. Read [references/operations-and-errors.md](references/operations-and-errors.md) for states, event polling, retries, and recovery rules.

When handling an error:

1. Preserve the stable error `code`, safe `message`, `request_id`, and `retryable` value.
2. Never include authorization headers, API keys, provider credentials, or secret values in diagnostics.
3. Retry GET requests only when the error is marked retryable.
4. Retry sandbox creation only with the same caller-supplied idempotency key and identical input, after checking the existing operation when possible.
5. Do not automatically retry pause, resume, or destroy; their idempotency headers are not currently enforced by the API.
6. Treat unknown provider outcomes as reconciliation states, not confirmed failures.

## Configuration Rules

- Keep provider candidates unique.
- A `provider_template` cannot use fallback. Prefer a matching explicit top-level provider; if it is omitted or `auto`, the service derives the provider from the template source.
- Use either `network.allow_domains` or `network.deny_domains`, never both.
- Prefer `architecture: "any"` unless the workload has a verified architecture requirement.
- Use `secret_refs` for references only, never raw secret values. Current adapters do not yet consume these references, so do not claim that secrets were injected.
- Treat requested and resolved resources separately; providers may map requests to a larger available tier.
- For managed routing, verify the organization has positive credit. BYOK uses the customer's provider account directly.

Read [references/sandbox-configuration.md](references/sandbox-configuration.md) for the complete schema and enforcement status. Read [references/providers-and-billing.md](references/providers-and-billing.md) before selecting a provider or configuring BYOK.
