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
export OPENMETAL_API_URL="https://api.openmetal.sh"
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

## Processes

Run an argv-based process:

```bash
openmetal sandbox exec <sandbox-id> \
  --cwd /workspace \
  --env NODE_ENV=production \
  --timeout 300 \
  --max-output-bytes 10485760 \
  -- node app.js --port 8080
```

Arguments after `--` are sent as argv and are not evaluated by a local shell. `--timeout` is the remote process timeout: 1 through 3,600 seconds, default 300. Captured stdout plus stderr defaults to 10 MiB and permits at most 100 MiB before lower provider limits. The command generates a stable idempotency key before creating the process, consumes ordered SSE events, and exits with the remote code. If streaming fails after acceptance, stderr reports `process_id` and `idempotency_key` for inspection or an identical replay.

Plain mode decodes `stdout` and `stderr` event bytes to the matching local streams. A nonzero remote exit adds no synthetic stderr and returns the remote code. `--json` buffers events and emits one `{ process, events }` document instead. Process output in JSON remains base64.

```bash
openmetal process get <sandbox-id> <process-id>
openmetal process events <sandbox-id> <process-id> --after 0
openmetal process cancel <sandbox-id> <process-id> --yes
```

`process events` reconnects finite SSE batches until a terminal event. Use `--after` with the last handled positive sequence when resuming. After an empty batch the SDK checks process status and returns if terminal, including when `--after` is at or beyond the terminal sequence; otherwise it waits before reconnecting. Cancellation is provider-dependent. There is no interactive PTY/terminal, streaming stdin, SSH, WebSocket, or general connection command.

## Filesystem

```bash
openmetal file upload <sandbox-id> ./input.bin /workspace/input.bin \
  --mode overwrite --create-parents --timeout 180
openmetal file upload <sandbox-id> - /workspace/stdin.bin
openmetal file download <sandbox-id> /workspace/input.bin ./input.bin \
  --offset 0 --chunk-size 1048576 --timeout 180
openmetal file list <sandbox-id> /workspace --recursive --max-entries 1000
openmetal file delete <sandbox-id> /workspace/input.bin --yes
```

`file upload` has alias `file write`; `file download` has alias `file read`. Upload accepts a local path or `-` for stdin and generates one stable idempotency key when omitted. If its accepted operation later fails or times out, stderr reports `runtime_operation_id` and `idempotency_key`; replay identical append input only with that key. Download writes a local path, raw stdout when omitted or `-`, or `data_base64` under `--json`. It reads from the requested offset through EOF; `--chunk-size` is per request, not a total limit, and inconsistent path/offset or zero-progress results fail before local output is written.

All four commands submit a runtime operation and wait up to `--timeout` seconds, default 180. Remote paths must be absolute and traversal-free. Uploads are at most 10 MiB; download chunks are at most 10 MiB; lists permit at most 10,000 entries. Provider support for list/delete, append, and parent creation differs.

## Leased HTTP Endpoints

```bash
openmetal endpoint expose <sandbox-id> --port 8080 --lease-seconds 3600
openmetal endpoint list <sandbox-id> --cursor <endpoint-id> --limit 50
openmetal endpoint revoke <sandbox-id> <endpoint-id> --yes
```

`endpoint expose` generates an idempotency key but returns the initial `provisioning` endpoint without waiting. Poll `endpoint list` for `active` with a URL or `failed`. Only HTTP is supported. Contract ports are 1 through 65,535, lease duration is 60 through 86,400 seconds, and list size is 1 through 100; provider restrictions can be narrower.

Read [runtime.md](runtime.md) for exact API and SDK names and [providers-and-billing.md](providers-and-billing.md) for current capability coverage.

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
- `sandbox exec`: the remote process exit code when available; otherwise `1`.
- Commander argument parsing may return its own nonzero exit code.

CLI errors are written to stderr as plain text even when `--json` is selected. Do not parse stderr as a JSON error envelope.
