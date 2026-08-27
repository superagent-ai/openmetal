# OpenMetal TypeScript SDK

Typed ESM client for the OpenMetal compute API. It validates API responses at runtime, applies request timeouts, retries safe GET requests, and supplies idempotency keys for sandbox mutations.

## Install

```bash
npm install @openmetal/sdk
```

Node.js 22 or later is supported. The package is also compatible with modern browser and edge runtimes that provide `fetch`, `AbortController`, and Web Crypto.

## Project API-key usage

Sandbox and operation routes use a project-scoped `metal_sk_*` key plus the project's public `prj_*` ID:

```ts
import { MetalClient } from "@openmetal/sdk";

const metal = new MetalClient({
  baseUrl: process.env.OPENMETAL_API_URL!,
  projectId: process.env.OPENMETAL_PROJECT_ID,
  accessToken: () => process.env.OPENMETAL_API_KEY,
});

const sandbox = await metal.sandboxes.create({
  source: {
    kind: "environment",
    environment: "metal/node",
    version: "latest",
  },
  resources: {
    vcpu: 2,
    memory_mb: 4096,
    architecture: "any",
  },
  lifecycle: {
    runtime_timeout_seconds: 1800,
  },
});
```

Use `createAsync()` to return the accepted sandbox and operation immediately:

```ts
const mutation = await metal.sandboxes.createAsync(request);
const operation = await metal.operations.wait(mutation.operation, {
  timeoutMs: 180_000,
});
```

Operation events are finite resumable batches rather than a permanently open stream:

```ts
const events = await metal.operations.events(operation.id, {
  lastEventId: 0,
});
```

## User-session usage

Organization, project, API-key, team, provider-credential, billing, and durable-event routes use a Supabase user access token:

```ts
const controlPlane = new MetalClient({
  baseUrl: process.env.OPENMETAL_API_URL!,
  accessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  },
});

const organizations = await controlPlane.organizations.list();
const projects = await controlPlane.projects.list(organizations.organizations[0].id);
```

The token provider runs before every request, allowing callers to refresh short-lived sessions without recreating the client.

## Errors

API failures throw `MetalError` with stable fields:

```ts
import { MetalError } from "@openmetal/sdk";

try {
  await metal.sandboxes.get("sbx_example");
} catch (error) {
  if (error instanceof MetalError) {
    console.error(error.code, error.status, error.requestId, error.retryable);
  }
}
```

Secret values and authorization headers should never be logged.

## Publishing

Build and test the public artifact:

```bash
OPENMETAL_SDK_VERSION=0.1.0 pnpm --filter @openmetal/sdk build:npm
pnpm --filter @openmetal/sdk exec vitest run test/npm-package.integration.test.ts
npm pack ./packages/sdk-typescript/dist/npm --dry-run
```

The first version must be published from an npm-authenticated maintainer computer because npm requires the package to exist before trusted publishing can be configured:

```bash
npm login
npm publish ./packages/sdk-typescript/dist/npm --access public
```

Then configure the GitHub OIDC publisher:

```bash
npm trust github @openmetal/sdk \
  --repo homanp/metal \
  --file release-sdk.yml \
  --allow-publish \
  --yes
```

The `release-sdk` workflow uses the protected `npm` GitHub environment. After trusted publishing is configured, push an `sdk-v*` tag or run the workflow manually. No npm token is stored in GitHub.
