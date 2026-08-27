# OpenMetal CLI

`openmetal` is a standalone CLI for the Metal control-plane API. It uses a Supabase user session for organization, project, team, provider-credential, and billing commands. Sandbox and operation commands use a project-scoped `metal_sk_*` API key.

## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/homanp/metal/main/scripts/install-openmetal.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/homanp/metal/main/scripts/install-openmetal.ps1 | iex
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

## Automation and CI

Every interactive flow has a flag or environment alternative. Use `--no-input` to reject missing choices, `--yes` for destructive commands, and `--json` for stable machine output.

```bash
export OPENMETAL_API_URL=https://api.example.com
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
openmetal config use-profile staging
openmetal --profile staging config set \
  --api-url https://staging-api.example.com \
  --supabase-url https://example.supabase.co \
  --supabase-publishable-key <publishable-key>
openmetal doctor
```

Generate shell completion setup with:

```bash
openmetal completion bash
openmetal completion zsh
openmetal completion fish
openmetal completion powershell
```

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
   OPENMETAL_DEFAULT_API_URL="<production-api-url>" \
   OPENMETAL_DEFAULT_SUPABASE_URL="<production-supabase-url>" \
   OPENMETAL_DEFAULT_SUPABASE_KEY="<publishable-key>" \
   pnpm --filter @openmetal/cli build:npm

   npm publish ./apps/cli/dist/npm --access public
   ```

3. Configure npm trusted publishing for repository `homanp/metal`, workflow `release-cli.yml`, with `npm publish` allowed:

   ```bash
   npm trust github @openmetal/cli \
     --repo homanp/metal \
     --file release-cli.yml \
     --allow-publish \
     --yes
   ```

4. Run the `release-cli` workflow with version `0.1.0` to publish the native GitHub release. It detects that the npm version already exists and does not republish it.

Later `cli-v*` releases publish npm through GitHub OIDC with automatic provenance. No npm token is stored in GitHub.
