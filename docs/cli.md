# OpenMetal CLI

`openmetal` is a standalone CLI for the Metal control-plane API. It uses a Supabase user session for organization, project, team, provider-credential, and billing commands. Sandbox, operation, process, filesystem, and endpoint commands use a project-scoped `metal_sk_*` API key plus its `prj_*` project ID.

## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/superagent-ai/openmetal/main/scripts/install-openmetal.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/superagent-ai/openmetal/main/scripts/install-openmetal.ps1 | iex
```

With Node.js 22 or later:

```bash
npm install --global @openmetal/cli
# or
npx @openmetal/cli --help
```

Set `OPENMETAL_VERSION=0.1.0` to install a specific `cli-v0.1.0` release and `OPENMETAL_INSTALL_DIR` to choose the destination. Installers verify the release SHA-256 checksum. Release archives can also be downloaded directly with `curl` from the repository's Releases page.

## First-time setup

The guided flow opens GitHub or Google login, selects or creates an organization and project, then creates a 90-day project key:

```bash
openmetal setup
```

The Supabase project must allow `http://127.0.0.1:54389/callback**` as an authentication redirect. Local development already includes this URL in `supabase/config.toml`.

For explicit setup:

```bash
openmetal auth login --provider github
openmetal org list
openmetal project create --organization <org-id> --name Demo --slug demo --use
openmetal api-key create --project <project-id> --name "Local CLI" --expires-in 90d --use
```

Credentials are kept separately from general configuration in a per-user OpenMetal directory. They are never printed by `config show`. A newly created API key is returned once by the API; redirect it carefully if using `--json`.

## Sandbox workflow

Create from common flags:

```bash
openmetal sandbox create \
  --environment metal/node \
  --environment-version latest \
  --vcpu 2 \
  --memory-mb 4096 \
  --runtime-timeout 1800
```

For the complete API request shape:

```bash
openmetal sandbox create --file sandbox.json
cat sandbox.json | openmetal sandbox create --stdin
```

Interactive terminal commands wait for sandbox operations by default. Piped/non-interactive commands return the accepted mutation immediately; pass `--async` to make that behavior explicit. Use `openmetal operation wait <op-id>` or `openmetal operation watch <op-id>` afterward.

```bash
openmetal sandbox list
openmetal sandbox get <sandbox-id>
openmetal sandbox pause <sandbox-id>
openmetal sandbox resume <sandbox-id>
openmetal sandbox delete <sandbox-id> --yes
```

## Processes

`sandbox exec` submits an argv array, consumes resumable finite SSE batches, writes decoded stdout and stderr to the corresponding local streams, waits for a terminal process event, and exits with the remote exit code. Arguments after `--` are not interpreted by a local shell:

```bash
openmetal sandbox exec <sandbox-id> \
  --cwd /workspace \
  --env NODE_ENV=production \
  --timeout 300 \
  --max-output-bytes 10485760 \
  -- node app.js --port 8080
```

`--timeout` is the remote process timeout, not a local streaming deadline. The API permits 1 through 3,600 seconds and 1 byte through 100 MiB of captured output, subject to lower provider limits. Process creation supplies an idempotency key automatically when `--idempotency-key` is omitted.

Plain output contains process stdout and stderr only. With `--json`, the CLI buffers process events and emits one object containing `process` and `events`; binary output remains base64 in that JSON. A nonzero remote exit does not add a synthetic message to stderr and exits with the remote code. A process that fails before returning an exit code exits the CLI with code 1.

The CLI generates the process idempotency key before submission. If the initial POST has an API, network, or timeout failure, stderr reports `idempotency_key`; replay only the identical create request with that key to recover the uncertain outcome. If event streaming or the final status request fails after acceptance, stderr also reports `process_id`, so inspect that process rather than starting a duplicate execution.

```bash
openmetal process get <sandbox-id> <process-id>
openmetal process events <sandbox-id> <process-id> --after 0
openmetal process cancel <sandbox-id> <process-id> --yes
```

`process events` reconnects finite SSE batches until an `exited`, `cancelled`, `timed_out`, or `failed` event. `--after` is the last successfully handled sequence. After an empty batch the SDK fetches process status and stops if it is terminal, so resuming at or after the terminal sequence terminates without a tight reconnect loop. Cancellation is provider-dependent.

OpenMetal does not expose an interactive PTY/terminal, stdin streaming, SSH, WebSocket, or general connection command.

## Filesystem

Filesystem commands submit asynchronous runtime operations and wait up to 180 seconds by default:

```bash
openmetal file upload <sandbox-id> ./artifact.bin /workspace/artifact.bin \
  --mode overwrite --create-parents --timeout 180
openmetal file upload <sandbox-id> - /workspace/stdin.bin

openmetal file download <sandbox-id> /workspace/artifact.bin ./artifact.bin \
  --offset 0 --chunk-size 1048576 --timeout 180
openmetal file list <sandbox-id> /workspace --recursive --max-entries 1000
openmetal file delete <sandbox-id> /workspace/artifact.bin --yes
```

`file upload` is aliased as `file write`; `file download` is aliased as `file read`. Upload and download preserve bytes without UTF-8 conversion. Upload generates one idempotency key before submission when omitted. An initial API, network, or timeout failure reports `idempotency_key`; retry only the identical write with that key. If waiting fails after the write is accepted, stderr reports both `runtime_operation_id` and `idempotency_key`; inspect the operation or replay the identical write with that key. Never retry append with a new key because it can duplicate bytes. Omitting the local download path writes raw bytes to stdout; `--json` instead emits `data_base64`. Download keeps requesting chunks from the initial offset until EOF, so `--chunk-size` controls each request rather than total download size, and rejects path/offset drift or a non-EOF chunk that makes no progress before writing the local output.

Portable remote paths must be absolute and cannot contain `.` or `..` traversal segments. A write is at most 10 MiB. Reads use chunks up to 10 MiB, and lists return at most 10,000 entries. Provider support can be narrower: some providers do not support list/delete, append, or parent creation.

## Leased HTTP endpoints

```bash
openmetal endpoint expose <sandbox-id> --port 8080 --lease-seconds 3600
openmetal endpoint list <sandbox-id> --limit 50
openmetal endpoint revoke <sandbox-id> <endpoint-id> --yes
```

`endpoint expose` returns the accepted endpoint immediately, normally in `provisioning`; it does not wait for `active`. Poll `endpoint list` for `active` and a URL or for `failed`. Only HTTP is supported. Ports are 1 through 65,535, leases are 60 through 86,400 seconds, and provider restrictions still apply.

## Automation and CI

Every interactive flow has a flag or environment alternative. Use `--no-input` to reject missing choices, `--yes` for destructive commands, and `--json` for stable machine output.

```bash
export OPENMETAL_API_URL=https://api.openmetal.sh
export OPENMETAL_PROJECT_ID=prj_example
export OPENMETAL_API_KEY=metal_sk_example

openmetal --no-input --json sandbox list
```

Supported variables:

- `OPENMETAL_API_URL` (`METAL_API_URL` is accepted as an alias)
- `OPENMETAL_ACCESS_TOKEN`
- `OPENMETAL_API_KEY` (`METAL_API_KEY` alias)
- `OPENMETAL_PROJECT_ID` (`METAL_PROJECT_ID` alias)
- `OPENMETAL_ORGANIZATION_ID`
- `OPENMETAL_PROFILE`
- `OPENMETAL_SUPABASE_URL`
- `OPENMETAL_SUPABASE_PUBLISHABLE_KEY`
- `OPENMETAL_CONFIG_HOME`
- `NO_COLOR` and `CI`

Precedence is command flags, environment, active profile, then compiled defaults.

## Profiles and diagnostics

```bash
openmetal config use-profile production
openmetal --profile production config set \
  --api-url https://api.openmetal.sh
openmetal doctor
```

Generate shell completion setup with:

```bash
openmetal completion bash
openmetal completion zsh
openmetal completion fish
openmetal completion powershell
```

## Exit codes and errors

- `0`: success.
- `1`: general error, failed operation, or process failure without an exit code.
- `2`: local Zod request validation error.
- `3`: API authentication or authorization error.
- `4`: SDK HTTP request timeout.
- `sandbox exec` returns the remote process exit code when one is available.

Commander argument parsing can return its own nonzero code. CLI errors are written to stderr as plain text even with `--json`; they include the stable API error code and request ID when available, but stderr is not a JSON error envelope.

## Development

```bash
pnpm --filter @openmetal/cli dev -- --help
pnpm --filter @openmetal/cli test
pnpm --filter @openmetal/cli typecheck
pnpm --filter @openmetal/cli build
apps/cli/dist/openmetal --help
```

Standalone builds use pinned Bun 1.3.11. Release CI produces macOS, Linux glibc/musl, and Windows artifacts for x64 and arm64.

For production login to work without local configuration, release maintainers set the public repository variables `OPENMETAL_API_URL`, `OPENMETAL_SUPABASE_URL`, and `OPENMETAL_SUPABASE_PUBLISHABLE_KEY` before pushing a `cli-v*` tag. These public endpoints are compiled as defaults; command flags and environment variables still override them.

### First npm publish

The first npm release cannot use trusted publishing because npm requires `@openmetal/cli` to exist before an OIDC trust can be configured.

1. Create or confirm the `@openmetal` npm scope and enable 2FA.
2. Merge the release workflow to the default branch, then build and publish `0.1.0` from an npm-authenticated local computer:

   ```bash
   npm login
   pnpm --filter @openmetal/contracts build
   pnpm --filter @openmetal/sdk build

   OPENMETAL_CLI_VERSION=0.1.0 \
   OPENMETAL_BUILD_COMMIT="$(git rev-parse HEAD)" \
   OPENMETAL_DEFAULT_API_URL="https://api.openmetal.sh" \
   OPENMETAL_DEFAULT_SUPABASE_URL="<production-supabase-url>" \
   OPENMETAL_DEFAULT_SUPABASE_KEY="<publishable-key>" \
   pnpm --filter @openmetal/cli build:npm

   npm publish ./apps/cli/dist/npm --access public
   ```

3. Configure npm trusted publishing for repository `superagent-ai/openmetal`, workflow `release-cli.yml`, with `npm publish` allowed:

   ```bash
   npm trust github @openmetal/cli \
     --repo superagent-ai/openmetal \
     --file release-cli.yml \
     --allow-publish \
     --yes
   ```

4. Create a GitHub Actions environment named `npm` and configure required reviewers plus deployment branch/tag restrictions.
5. Run the `release-cli` workflow with version `0.1.0` to publish the native GitHub release. It detects that the npm version already exists and does not republish it.

Later `cli-v*` releases publish npm through GitHub OIDC with automatic provenance. No npm token is stored in GitHub.
