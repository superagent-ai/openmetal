# OpenMetal TypeScript SDK

Typed ESM client for the OpenMetal compute API. It validates API responses at runtime, applies request timeouts, retries safe GET requests, and supplies idempotency keys for sandbox, process-create, and endpoint-create mutations.

## Install

```bash
npm install @openmetal/sdk
```

Node.js 22 or later is supported. The package is also compatible with modern browser and edge runtimes that provide `fetch`, `AbortController`, and Web Crypto.

## Project API-key usage

Sandbox, process, filesystem, and endpoint routes use a project-scoped `metal_sk_*` key plus the project's public `prj_*` ID:

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

Operation get/event routes require the exact project key associated with the originating sandbox but do not require the `X-Metal-Project-ID` header.

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

## Processes

`processes.create()` returns a queued process and generates an idempotency key when one is not supplied. Process execution is asynchronous; consume `processes.events()` or poll `processes.get()`:

```ts
const process = await metal.processes.create(sandbox.id, {
  command: ["node", "app.js"],
  cwd: "/workspace",
  environment: { NODE_ENV: "production" },
  timeout_seconds: 300,
  max_output_bytes: 10 * 1024 * 1024,
});

for await (const event of metal.processes.events(sandbox.id, process.id)) {
  if (event.type === "stdout" || event.type === "stderr") {
    const bytes = Uint8Array.from(atob(event.data.data_base64), (value) => value.charCodeAt(0));
    // Route bytes by event.type.
  }
}
```

The API returns finite SSE batches. The async iterable reconnects with `Last-Event-ID`, enforces contiguous sequence numbers, and ends on `exited`, `cancelled`, `timed_out`, or `failed`. After an empty batch it fetches process status and also ends if the process is terminal, including when `lastEventId` is at or after the terminal event; otherwise it waits for `reconnectDelayMs` before reconnecting. Pass `lastEventId`, `reconnectDelayMs`, `projectId`, or an `AbortSignal` when resuming or cancelling local consumption. `processes.cancel()` requests provider-dependent cancellation.

Process timeout defaults to 300 seconds and permits 1 through 3,600; captured output defaults to 10 MiB and permits up to 100 MiB before lower provider limits.

The public contract runs argv-based processes and captures separate stdout/stderr. Output streams while the command runs when the provider supports ordered streaming and appears after completion for buffered providers. It does not expose an interactive PTY/terminal, streaming stdin, SSH, WebSocket, or general connection API.

## Filesystem

Low-level methods return queued runtime operations:

```ts
const queued = await metal.filesystem.write(sandbox.id, {
  path: "/workspace/data.bin",
  data: new Uint8Array([0, 255, 128]),
  mode: "overwrite",
  create_parents: true,
});
const completed = await metal.runtimeOperations.wait(queued);
```

Available methods are `filesystem.read`, `write`, `list`, and `delete`, plus `runtimeOperations.get` and `wait`. `filesystem.write()` generates an idempotency key when omitted. `wait()` defaults to 180 seconds and 500 millisecond polling; when passed only a runtime-operation ID it also requires `sandboxId`.

`filesystem.upload()` writes binary data and waits for completion. It generates one idempotency key when omitted and, if waiting fails after acceptance, throws `RuntimeOperationWaitError` with `operationId` and `idempotencyKey` for safe inspection or replay of the identical write. This is especially important for append, where retrying with a new key could duplicate bytes. `filesystem.download()` repeatedly reads base64 chunks through EOF and returns a `Uint8Array`:

```ts
await metal.filesystem.upload(sandbox.id, "/workspace/input.bin", bytes, {
  createParents: true,
});
const downloaded = await metal.filesystem.download(sandbox.id, "/workspace/input.bin", {
  chunkSizeBytes: 1024 * 1024,
});
```

Each download result must repeat the requested path and byte offset, report a matching decoded byte length, and either reach EOF or make forward progress; the helper rejects an inconsistent chunk before returning any bytes. Paths must be absolute without `.` or `..` traversal segments. Reads and writes are limited to 10 MiB per operation, and lists to 10,000 entries, with lower or narrower provider limits possible. Provider capability failures appear on the completed runtime operation rather than the initial `202` response.

## Leased HTTP endpoints

```ts
const endpoint = await metal.endpoints.create(sandbox.id, {
  port: 8080,
  protocol: "http",
  lease_seconds: 3600,
});
const page = await metal.endpoints.list(sandbox.id, { limit: 50 });
await metal.endpoints.revoke(sandbox.id, endpoint.id);
```

Create generates an idempotency key and returns a `provisioning` endpoint immediately; there is no endpoint wait helper or single-endpoint GET. Poll `endpoints.list()` for `active` and a URL or for `failed`. Only HTTP is supported, with ports 1 through 65,535 and lease durations from 60 through 86,400 seconds before narrower provider restrictions.

See [the runtime API reference](../../docs/runtime.md) for exact routes, states, errors, and current provider coverage.

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
    console.error(error.code, error.status, error.requestId, error.retryable, error.idempotencyKey);
  }
}
```

Secret values and authorization headers should never be logged.

HTTP and response-validation failures throw `MetalError`. When a process create or filesystem write/upload helper supplies an idempotency key, the same value is available as `error.idempotencyKey` after an initial API, network, or timeout failure. Reuse that key only with the identical request to recover an uncertain POST outcome. Runtime wait deadlines and helper-level failures throw regular `Error`; an upload failure after acceptance throws `RuntimeOperationWaitError` with both the operation ID and key. The client retries only GET requests marked retryable; mutating methods are never retried automatically.

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
  --repo superagent-ai/openmetal \
  --file release-sdk.yml \
  --allow-publish \
  --yes
```

The `release-sdk` workflow uses the protected `npm` GitHub environment. After trusted publishing is configured, push an `sdk-v*` tag or run the workflow manually. No npm token is stored in GitHub.
