# OpenMetal CLI Reference

Read this reference when installing or using the `openmetal` command, setting up credentials, writing shell automation, or diagnosing CLI behavior.

## Install

Public CLI packages and release archives may not exist until the first release is published. Check release availability before presenting an installation command as usable.

With Node.js 22 or later, after `@openmetal/cli` is published:

```bash
npm install --global @openmetal/cli
# Run without installing globally:
npx @openmetal/cli --help
```

For development from a repository checkout, install Node.js 22, pnpm 11.13.1, and Bun 1.3.11:

```bash
pnpm install --frozen-lockfile
pnpm --filter @openmetal/cli dev -- --help
```

When release archives are available, prefer a pinned release and verify its published SHA-256 checksum. Do not pipe a mutable script from the repository's `main` branch directly into a shell without reviewing it.

## Initial Setup

The guided setup opens GitHub or Google login, selects or creates an organization and project, and creates a 90-day project API key:

```bash
openmetal setup
openmetal doctor
```

`openmetal setup` creates a project API key and prints its one-time plaintext value. An agent whose terminal output is recorded must ask the user to run this command in a trusted terminal instead of executing it.

For explicit setup:

```bash
openmetal auth login --provider github
openmetal org list
openmetal project create \
  --organization <organization-id> \
  --name Demo \
  --slug demo \
  --use
openmetal api-key create \
  --project <project-id> \
  --name "Local CLI" \
  --expires-in 90d \
  --use
```

`api-key create` also prints the one-time plaintext key, even with `--use`. Treat its stdout as a secret and do not run it in CI logs or an agent transcript.

The browser login callback is `http://127.0.0.1:54389/callback`. Use `--no-browser` to print the login URL instead of opening it. Do not use browser login in unattended CI.

## Automation

Set the project-scoped credentials in the environment:

```bash
export OPENMETAL_API_URL="https://api.example.com"
export OPENMETAL_PROJECT_ID="prj_example"
export OPENMETAL_API_KEY="metal_sk_example"

openmetal --json --no-input sandbox list
```

Replace the example values. Do not print these variables or commit them to the repository.

Use these global options before the subcommand:

- `--json` emits stable, pretty JSON. Non-TTY stdout emits compact JSON automatically.
- `--no-input` fails rather than prompting.
- `--yes` confirms destructive operations.
- `--profile`, `--api-url`, `--organization`, and `--project` override stored context.
- `--access-token` and `--api-key` are available but environment variables are safer than process arguments in automation.

### Configuration Precedence

- Profile: `--profile`, `OPENMETAL_PROFILE`, active profile.
- API URL: `--api-url`, `OPENMETAL_API_URL`, `METAL_API_URL`, profile, compiled default.
- Project: `--project`, `OPENMETAL_PROJECT_ID`, `METAL_PROJECT_ID`, profile.
- Organization: `--organization`, `OPENMETAL_ORGANIZATION_ID`, profile.
- User token: `--access-token`, `OPENMETAL_ACCESS_TOKEN`, stored session.
- Project API key: `--api-key`, `OPENMETAL_API_KEY`, `METAL_API_KEY`, stored key for the active project.

Profiles live under `$OPENMETAL_CONFIG_HOME`, `$XDG_CONFIG_HOME/openmetal`, `~/.config/openmetal`, or `%APPDATA%\openmetal`. General settings are in `config.json`; sessions and project keys are in `credentials.json`. The CLI writes private files atomically and uses restrictive permissions where the platform supports them.

## Create Sandboxes

Basic portable environment:

```bash
openmetal sandbox create \
  --environment metal/node \
  --environment-version latest \
  --vcpu 2 \
  --memory-mb 4096 \
  --runtime-timeout 1800 \
  --async
```

OCI image:

```bash
openmetal sandbox create \
  --image node:22-bookworm \
  --vcpu 2 \
  --memory-mb 4096 \
  --runtime-timeout 1800
```

Only common fields are available as flags. Use a JSON file for the full request:

```bash
openmetal --json --no-input sandbox create \
  --file sandbox.json \
  --idempotency-key <stable-key> \
  --async
```

Or pipe one JSON object through stdin:

```bash
openmetal --json --no-input sandbox create --stdin --async < sandbox.json
```

`--file` or `--stdin` supplies the whole request and replaces the request assembled from common flags. Do not assume the other create flags are merged into that JSON.

Interactive TTY creation waits up to 180 seconds by default. Prefer `--async`, which returns a mutation containing both `sandbox` and `operation` immediately. This preserves the IDs needed for recovery if a later wait or final sandbox read fails. Non-TTY output also returns the accepted mutation immediately.

## Operations

Wait for an accepted mutation:

```bash
openmetal --json --no-input operation wait <operation-id> --timeout 180
```

Inspect or retrieve finite event batches:

```bash
openmetal --json --no-input operation get <operation-id>
openmetal --json --no-input operation events <operation-id> --after 0
openmetal operation watch <operation-id> --timeout 180
```

`operation events` returns one finite resumable batch. `operation watch` polls batches and the operation until it reaches a terminal state. Preserve the last event sequence when implementing custom polling.

Operation access is currently tied to the exact project API key that created the sandbox, not just the project. Keep the same key available while waiting on or inspecting its operations. Rotating to another valid project key can make existing operations return `not_found`.

## Lifecycle

```bash
openmetal --json --no-input sandbox list --limit 50
openmetal --json --no-input sandbox get <sandbox-id>
openmetal --json --no-input sandbox pause <sandbox-id> --async
openmetal --json --no-input sandbox resume <sandbox-id> --async
openmetal --json --no-input --yes sandbox delete <sandbox-id> --async
```

`sandbox destroy` is an alias for `sandbox delete`. Pause and resume fail when the selected provider does not support the requested action.

Do not automatically resubmit pause, resume, or delete after a lost response. The API does not currently enforce their idempotency headers, and duplicate in-flight requests can create operations that never complete. Retain the original operation ID and inspect sandbox state before taking further action.

Current server builds can serialize resolved resource fields in a shape rejected by the SDK used inside the CLI. Reads of a ready sandbox and lifecycle mutation responses can fail with `internal_error: malformed metal api response` even when the server-side action succeeded. Always create with `--async` so the initial IDs are emitted. Do not retry a lifecycle mutation after this parsing error; upgrade or fix the server before relying on unattended lifecycle automation.

## BYOK Credentials

Provider credentials are organization-scoped and require a user session. The JSON includes a `provider` field matching `--provider`:

```bash
openmetal provider-credential set \
  --organization <organization-id> \
  --provider e2b \
  --file e2b-credentials.json

openmetal provider-credential list --organization <organization-id>
openmetal --yes provider-credential remove \
  --organization <organization-id> \
  --provider e2b
```

Credential files contain secrets. Keep them outside source control, restrict their permissions, and remove them after configuration. See [providers-and-billing.md](providers-and-billing.md) for exact input shapes.

## Exit Codes

- `0`: success.
- `1`: general error or failed operation.
- `2`: request validation error.
- `3`: API authentication or authorization error.
- `4`: SDK request timeout.
- Commander argument parsing may return its own nonzero exit code.

CLI errors are written to stderr as plain text even when `--json` is selected. Do not parse stderr as a JSON error envelope.
