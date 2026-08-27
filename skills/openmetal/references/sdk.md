# OpenMetal TypeScript SDK Reference

Read this reference when integrating OpenMetal into TypeScript, choosing synchronous or asynchronous methods, handling errors, or implementing retries.

## Install And Construct A Client

Install the ESM package on Node.js 22 or later after `@openmetal/sdk` has been published. The package and GitHub release may not exist before the first release, so check availability instead of assuming installation succeeded:

```bash
npm install @openmetal/sdk
```

The `/v1/sandboxes` and sandbox runtime routes require a project API key and project ID:

```ts
import { MetalClient } from "@openmetal/sdk";

const metal = new MetalClient({
  baseUrl: process.env.OPENMETAL_API_URL!,
  projectId: process.env.OPENMETAL_PROJECT_ID!,
  accessToken: () => process.env.OPENMETAL_API_KEY,
  timeoutMs: 10_000,
  retry: {
    attempts: 2,
    backoffMs: 100,
  },
});
```

The `/v1/operations/{operation_id}` and `/events` routes require the exact project API key associated with the originating sandbox but do not require the project ID header.

The token callback runs before every request. It may return a promise, which lets applications refresh short-lived user sessions without rebuilding the client.

Use a separate user-session client for organization, project, API-key, provider-credential, team, billing, and durable-event routes:

```ts
const controlPlane = new MetalClient({
  baseUrl: process.env.OPENMETAL_API_URL!,
  accessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  },
});
```

Do not use a project API key for user-session routes or a Supabase session for project-key sandbox routes.

## Create And Wait

Prefer `createAsync()` so the application receives and can persist the sandbox and operation IDs before waiting:

```ts
const idempotencyKey = crypto.randomUUID();
const mutation = await metal.sandboxes.createAsync(
  {
    provider: "auto",
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
      on_runtime_timeout: "destroy",
    },
  },
  {
    idempotencyKey,
  },
);

const operation = await metal.operations.wait(mutation.operation, {
  timeoutMs: 180_000,
});

if (operation.state !== "succeeded") {
  throw new Error(operation.error?.message ?? `Operation ${operation.state}`);
}

const sandbox = await metal.sandboxes.get(mutation.sandbox.id);
```

`create()` also exists and normally submits, waits, verifies success, and fetches the final sandbox. Prefer the explicit asynchronous sequence because `create()` cannot return the accepted IDs if its final read fails.

The SDK generates an idempotency key if one is omitted. When application code may repeat `createAsync()` after an uncertain result, generate and persist one stable key before the first call, then reuse that same key. A new generated key represents a new mutation.

## List And Inspect

Use project-key scoped routes:

```ts
let cursor: string | undefined;

do {
  const page = await metal.sandboxes.listScoped({
    cursor,
    limit: 50,
  });

  for (const sandbox of page.sandboxes) {
    console.log(sandbox.id, sandbox.state, sandbox.provider);
  }

  cursor = page.next_cursor ?? undefined;
} while (cursor);
```

Do not log the complete client options, environment, or requested secret values.

## Lifecycle

The waiting lifecycle helpers return the updated sandbox:

```ts
const paused = await metal.sandboxes.pause(sandbox.id, undefined, {
  timeoutMs: 180_000,
});

const resumed = await metal.sandboxes.resume(paused.id, {
  timeoutMs: 180_000,
});

const stopped = await metal.sandboxes.delete(resumed.id, {
  timeoutMs: 180_000,
});
```

Use `pauseAsync()`, `resumeAsync()`, and `deleteAsync()` to receive a mutation immediately. Pause and resume are provider-dependent. Destroy is intended to be idempotent.

The current API enforces idempotency only for sandbox creation. Although asynchronous lifecycle SDK methods accept an idempotency key, the server currently ignores it for pause, resume, and destroy. Do not automatically resubmit these actions after a lost response. Retain the original operation ID and fetch current state first.

## Operation Events

Operation events are finite SSE batches, not a permanently open stream:

```ts
let lastEventId = 0;

while (true) {
  const events = await metal.operations.events(operationId, { lastEventId });
  for (const event of events) {
    lastEventId = event.sequence;
    console.log(event.sequence, event.type, event.occurred_at);
  }

  const operation = await metal.operations.get(operationId);
  if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}
```

Preserve `lastEventId` across reconnects to avoid processing the same event twice.

Operation authorization is currently tied to the exact project API key that created the sandbox. Use that same key to retrieve and wait on operations. Another valid key for the same project can receive `not_found`, including after key rotation.

## Processes

Create and consume a process:

```ts
const process = await metal.processes.create(sandbox.id, {
  command: ["node", "app.js"],
  cwd: "/workspace",
  environment: { NODE_ENV: "production" },
  timeout_seconds: 300,
  max_output_bytes: 10 * 1024 * 1024,
});

for await (const event of metal.processes.events(sandbox.id, process.id, {
  signal,
})) {
  if (event.type === "stdout" || event.type === "stderr") {
    handleBase64Bytes(event.type, event.data.data_base64);
  }
}
```

`processes.create()` returns a queued process and generates an idempotency key when omitted. `processes.get()` reads current state. `processes.cancel()` requests provider-dependent cancellation and accepts an optional idempotency key.

The process event endpoint returns finite SSE batches. `processes.events()` is an `AsyncIterable` that reconnects after 250 milliseconds by default, sends the last sequence in `Last-Event-ID`, rejects a sequence gap, and ends on `exited`, `cancelled`, `timed_out`, or `failed`. After an empty batch it fetches process status, returns if terminal, or waits for the reconnect delay. Use `lastEventId` to resume and `signal` to stop local consumption.

If `lastEventId` is at or after the terminal event, the empty-batch status check terminates the iterable.

Limits are 4,096 argv entries, 131,072 characters per entry, 1 through 3,600 seconds timeout, and 1 byte through 100 MiB captured output, subject to lower provider limits.

## Filesystem

Low-level methods return queued runtime operations:

```ts
const queued = await metal.filesystem.write(
  sandbox.id,
  {
    path: "/workspace/input.bin",
    data: new Uint8Array([0, 255, 128]),
    mode: "overwrite",
    create_parents: true,
  },
  { idempotencyKey: crypto.randomUUID() },
);

const completed = await metal.runtimeOperations.wait(queued, {
  timeoutMs: 180_000,
  pollIntervalMs: 500,
  signal,
});
```

Methods are `filesystem.read`, `write`, `list`, and `delete`, plus `runtimeOperations.get` and `wait`. A wait by runtime-operation ID instead of object also requires `{ sandboxId }`.

`metal.filesystem.upload()` accepts `ArrayBuffer`, an `ArrayBufferView` such as `Uint8Array` or Node.js `Buffer`, or `Blob`, then waits for the write. It generates one idempotency key when omitted. If waiting fails after acceptance, it throws `RuntimeOperationWaitError` carrying `operationId` and `idempotencyKey`; inspect the operation or replay the identical write with that key, especially for append. `metal.filesystem.download()` repeatedly reads chunks until EOF and returns a `Uint8Array`. Its `chunkSizeBytes` or `limitBytes` controls each read, not a total download cap, and it validates every returned path, offset, byte length, and non-EOF forward-progress condition before returning bytes.

Paths are absolute and traversal-free. Reads and decoded writes are at most 10 MiB per operation; lists are at most 10,000 entries. Provider support for list/delete, append, and parent creation varies. Inspect the completed operation for `capability_unsupported`.

## Leased HTTP Endpoints

```ts
const endpoint = await metal.endpoints.create(sandbox.id, {
  port: 8080,
  protocol: "http",
  lease_seconds: 3600,
});

const page = await metal.endpoints.list(sandbox.id, { limit: 50 });
await metal.endpoints.revoke(sandbox.id, endpoint.id);
```

Create generates an idempotency key and returns the initial endpoint, normally `provisioning`. There is no endpoint wait helper or single-endpoint GET; poll `endpoints.list()` for `active` with a non-null URL or `failed`. Only HTTP is supported, with ports 1 through 65,535 and lease durations 60 through 86,400 seconds before narrower provider checks.

Read [runtime.md](runtime.md) for exact routes and event/result shapes, and [providers-and-billing.md](providers-and-billing.md) for current provider coverage.

## Errors And Retries

```ts
import { MetalError } from "@openmetal/sdk";

try {
  await metal.sandboxes.get("sbx_example");
} catch (error) {
  if (error instanceof MetalError) {
    console.error({
      code: error.code,
      status: error.status,
      requestId: error.requestId,
      retryable: error.retryable,
    });
  }
  throw error;
}
```

The SDK retries only GET requests and only retryable `MetalError` failures. With the default `attempts: 2`, a GET can make up to three attempts using exponential backoff with jitter. Mutating methods are not automatically retried.

Each HTTP request has a 10-second default request timeout. Operation waits have a separate 180-second default deadline and poll every 500 milliseconds. An operation wait deadline throws a regular `Error`; an individual HTTP abort is a retryable `MetalError` with code `timeout`.

Runtime-operation waits use the same 180-second default and 500 millisecond polling interval. Filesystem upload/download helper failures and unsuccessful completed operations also throw regular `Error`.

Never log authorization headers, access tokens, API keys, provider credentials, or secret values.

## Available Namespaces

- `organizations`: create, list, get.
- `projects`: create, list, get, update, delete.
- `apiKeys`: create, list, revoke, delete.
- `providerCredentials`: list, configure, remove.
- `sandboxes.list(projectId)`: legacy user-session route.
- `sandboxes.listScoped`, create, createAsync, get, pause, pauseAsync, resume, resumeAsync, delete, and deleteAsync: project-key routes.
- `operations`: get, events, wait.
- `processes`: create, get, events, cancel.
- `filesystem`: read, write, list, delete, upload, download.
- `runtimeOperations`: get, wait.
- `endpoints`: create, list, revoke.
- `events`: list durable project events.
- `billing`, `members`, and `invitations`: control-plane administration.

There are no SDK namespaces for interactive PTY/terminal sessions, streaming stdin, SSH, WebSocket, or general connections.
