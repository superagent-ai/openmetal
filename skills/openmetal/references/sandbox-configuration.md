# Sandbox Configuration

Read this reference before constructing a full sandbox request, selecting a source, requiring capabilities, or making claims about enforcement.

## Complete Example

```json
{
  "provider": "auto",
  "source": {
    "kind": "environment",
    "environment": "metal/node",
    "version": "latest"
  },
  "resources": {
    "vcpu": 2,
    "memory_mb": 4096,
    "disk_mb": 8192,
    "architecture": "any"
  },
  "lifecycle": {
    "runtime_timeout_seconds": 1800,
    "on_runtime_timeout": "destroy"
  },
  "fallback": {
    "providers": ["e2b", "runloop", "daytona"],
    "max_attempts": 3
  },
  "metadata": {
    "agent": "example",
    "purpose": "temporary-development"
  }
}
```

This example is also available at `assets/sandbox.example.json`.

## Provider Selection

`provider` is optional and accepts `auto` or one of:

```text
blaxel, cloudflare, codesandbox, daytona, e2b, freestyle, modal,
northflank, prime, runloop, vercel
```

Omitting `provider` behaves as automatic selection. Prefer automatic selection unless the task has a concrete provider requirement.

`fallback.providers` is an ordered array of up to nine providers. `fallback.max_attempts` is an integer from 1 through 10 and defaults to 9. It limits provider calls; candidates skipped for unmet requirements do not count. Primary and fallback candidates must be unique.

With automatic selection, explicit fallback providers are tried first, followed by other configured providers in registry order. With an explicit provider, the primary is tried first, followed by the listed fallbacks. Candidates that fail a requirement in [Features](#features), [Network](#network), [Regions](#regions), source, or resources are skipped before OpenMetal calls them. After a provider call, safe fallback is currently limited to capacity, provider-unavailable, known-absent timeout, and provider-declined unsupported-request failures. Unknown outcomes enter reconciliation before another provider is attempted.

## Sources

### Portable Environment

```json
{
  "kind": "environment",
  "environment": "metal/node",
  "version": "latest"
}
```

Recognized environments are `metal/base`, `metal/node`, and `metal/python`. The version is validated and stored, but currently does not affect provisioning.

### OCI Image

```json
{
  "kind": "oci_image",
  "image": "node:22-bookworm",
  "command": ["node", "server.js"]
}
```

The image string has a 500-character maximum. The optional command has at most 4096 elements, each at most 131072 characters. Prime applies the OCI command as a one-shot VM start command (the VM stops when it exits); other adapters may not apply it.

Daytona starts an OCI image by building `FROM <image>` and does not return the sandbox until Daytona reports it started. The first pull can take minutes. Set `disk_mb` to at least the uncompressed image size; when it is omitted, Daytona receives 16 GiB instead of its 3 GiB default.

Only providers declaring OCI support are eligible.

### Provider Template

```json
{
  "provider": "e2b",
  "source": {
    "kind": "provider_template",
    "provider": "e2b",
    "template": "my-template"
  },
  "resources": {
    "vcpu": 2,
    "memory_mb": 4096,
    "architecture": "any"
  },
  "lifecycle": {
    "runtime_timeout_seconds": 1800
  }
}
```

Provider templates cannot use fallback. Prefer a matching explicit top-level provider; if it is omitted or `auto`, the service derives the primary provider from `source.provider`. Provider templates are supported by CodeSandbox, E2B, Freestyle, Prime, and Runloop. Freestyle templates are snapshot IDs or slugs; pin an immutable snapshot ID for reproducibility. Prime templates are `prime/` image references.

## Resources

| Field          | Rules                        | Notes                                                   |
| -------------- | ---------------------------- | ------------------------------------------------------- |
| `vcpu`         | Positive number              | Some providers map this to a larger tier.               |
| `memory_mb`    | Integer, minimum 128         | Expressed in MiB.                                       |
| `disk_mb`      | Optional nonnegative integer | May not be independently configurable.                  |
| `architecture` | `x86_64`, `arm64`, or `any`  | Defaults to `any`. Verified `arm64` routing is limited. |

Inspect `resolved_resources` on the resulting sandbox. It records the actual CPU, memory, disk, architecture, and provider tier when known.

CodeSandbox and Runloop use tier mapping. A request can resolve to a larger tier than requested. CodeSandbox tiers are `Pico`, `Nano`, `Micro`, `Small`, `Medium`, `Large`, and `XLarge`. Runloop tiers are `X_SMALL`, `SMALL`, `MEDIUM`, `LARGE`, `X_LARGE`, and `XX_LARGE`.

## Lifecycle

```json
{
  "runtime_timeout_seconds": 1800,
  "idle_timeout_seconds": 600,
  "on_runtime_timeout": "destroy",
  "on_idle_timeout": "destroy"
}
```

- `runtime_timeout_seconds` is required and must be an integer from 1 through 172800.
- `idle_timeout_seconds`, when present, must be a positive integer.
- Timeout actions accept `destroy` or `pause` and default to `destroy`.

Current enforcement limitation: runtime expiry schedules destruction even if `on_runtime_timeout` is `pause`. Idle timeout and `on_idle_timeout` are not currently enforced. Use runtime destruction for behavior that must happen reliably.

## Features

```json
{
  "isolation": ["microvm", "vm"],
  "pause_resume": true,
  "public_ports": [3000, 8080],
  "process": { "execute": true, "ordered_output": true },
  "filesystem": { "list": true, "delete": true, "write_modes": ["overwrite"] }
}
```

Every feature is a hard routing requirement. The worker removes any candidate provider that cannot satisfy it before calling that provider, records why, and tries the next candidate. When no candidate qualifies, the create operation fails with `no_eligible_provider` and `error.details.attempts[].unmet_requirements`.

- `isolation` lists acceptable boundaries: `microvm`, `vm`, and `container`. A provider qualifies only when its declared boundary is in the list. Unknown isolation never qualifies. Current claims are provider-reported, not independently verified: microVM for Blaxel, CodeSandbox, E2B, Runloop, and Vercel; VM for Freestyle and Prime; container for Cloudflare, Daytona, and Modal. Northflank is unknown.
- `pause_resume: true` requires reliable pause and resume.
- `public_ports` requires leased HTTP endpoints, which only Blaxel currently provides.
- `pty: true` always fails. Interactive PTY sessions are not part of the OpenMetal API.
- `process` accepts `execute`, `ordered_output` (streamed output), and `cancel`.
- `filesystem` accepts `read`, `write`, `write_modes`, `create_parents`, `list`, and `delete`.
- `computer_use` and `recording` require those computer capabilities.

When `provider` is omitted or `auto`, routing also requires process execution and file read and write unless you set `process.execute`, `filesystem.read`, or `filesystem.write` to `false`. This keeps automatic routing off providers such as CodeSandbox and Northflank, whose adapters currently expose lifecycle only. Explicit providers only need the features you request.

## Network

```json
{
  "internet_access": true,
  "deny_domains": ["example.invalid"]
}
```

`allow_domains` and `deny_domains` are mutually exclusive. Each list can contain at most 256 names, each at most 253 characters.

Network restrictions fail closed. No current adapter applies outbound restrictions, so `internet_access: false`, any `allow_domains` list, or a nonempty `deny_domains` list makes every provider ineligible and the create fails with `no_eligible_provider`. Omit the network block, or set `internet_access: true`, when unrestricted egress is acceptable.

## Regions

`regions` lists acceptable placement regions. A provider qualifies only when every region it may place a sandbox in is on the list. No current adapter declares its placement regions, so any nonempty `regions` list currently fails with `no_eligible_provider`.

## Environment, Secrets, And Metadata

```json
{
  "environment": {
    "NODE_ENV": "test"
  },
  "secret_refs": {
    "GITHUB_TOKEN": "secret-reference"
  },
  "metadata": {
    "agent_id": "agent-123",
    "run_id": "run-456"
  }
}
```

- Environment values can contain at most 16384 characters.
- Secret reference values are strings. Never put plaintext secrets in this object.
- Metadata values can contain at most 500 characters.

Current enforcement limitation: the Prime adapter injects plain `environment` values at creation, rejects nonempty `secret_refs`, and tags the VM with deterministic Metal labels. Other real adapters may not consume user-supplied fields. Do not treat stored intent as proof of secret injection or tagging across providers.

## Provider Options

Provider options are grouped by provider name:

```json
{
  "provider_options": {
    "codesandbox": {
      "template_id": "template-id",
      "vm_tier": "Nano"
    },
    "e2b": {
      "template_id": "template-id"
    },
    "freestyle": {
      "snapshot_id": "freestyle/ubuntu-sm"
    },
    "northflank": {
      "deployment_plan": "nf-compute-20",
      "ephemeral_storage_mb": 4096
    },
    "prime": {
      "team_id": "optional-prime-team-id"
    },
    "runloop": {
      "resource_size": "SMALL",
      "blueprint_id": "blueprint-id"
    }
  }
}
```

When an explicit provider is selected, options may only be supplied for that provider or its fallback candidates. CodeSandbox, E2B, Freestyle, Northflank, Prime, and Runloop have typed options. Other provider option objects accept provider-specific keys but offer fewer contract-level guarantees.

## Enforcement Summary

| Configuration                     | Current behavior                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| Source kind                       | Validated and used for provider eligibility.                                               |
| CPU, memory, disk, architecture   | Validated and used for provider eligibility and resource resolution.                       |
| Runtime duration                  | Enforced through a scheduled destroy job.                                                  |
| Provider and fallback             | Used by provisioning routing.                                                              |
| Provider options                  | Passed to the selected adapter.                                                            |
| Regions                           | Hard eligibility filter. No adapter declares regions, so requests currently fail.          |
| Features                          | Hard eligibility filter against declared and discovered capabilities.                      |
| Network policy                    | Hard eligibility filter. No adapter enforces restrictions, so they currently fail.         |
| Idle timeout                      | Stored, not enforced.                                                                      |
| Runtime action `pause`            | Stored, but expiry currently destroys.                                                     |
| Environment and secret references | Passed to adapters, but not consumed by current real adapters.                             |
| OCI command                       | Stored and passed to the adapter boundary, but not applied by current adapters.            |
| Environment version               | Stored, but does not currently affect provisioning.                                        |
| Metadata                          | Stored and passed to adapters, but user metadata is not consumed by current real adapters. |
