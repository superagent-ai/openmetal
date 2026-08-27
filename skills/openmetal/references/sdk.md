# OpenMetal TypeScript SDK Reference

Read this reference when integrating OpenMetal into TypeScript, choosing synchronous or asynchronous methods, handling errors, or implementing retries.

## Install And Construct A Client

Install the ESM package on Node.js 22 or later after `@openmetal/sdk` has been published. The package and GitHub release may not exist before the first release, so check availability instead of assuming installation succeeded:

```bash
npm install @openmetal/sdk
```

The current `/v1/sandboxes` and `/v1/operations` routes require a project API key and project ID:

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

Current server compatibility warning: provider adapters can persist `resolved_resources` with internal camel-case keys while the public SDK expects snake-case keys. After a provider returns resolved resources, `create()`, `get()`, `listScoped()`, or a lifecycle mutation can therefore throw `MetalError` with `internal_error` and `malformed metal api response` even though the operation succeeded. `createAsync()` returns before those resources are populated, allowing the caller to retain the IDs. A lifecycle mutation response already contains the ready sandbox and can fail validation before returning its new operation ID. Do not resubmit the action after this error; upgrade or fix the server before relying on unattended lifecycle automation.

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

Never log authorization headers, access tokens, API keys, provider credentials, or secret values.

## Available Namespaces

- `organizations`: create, list, get.
- `projects`: create, list, get, update, delete.
- `apiKeys`: create, list, revoke, delete.
- `providerCredentials`: list, configure, remove.
- `sandboxes.list(projectId)`: legacy user-session route.
- `sandboxes.listScoped`, create, createAsync, get, pause, pauseAsync, resume, resumeAsync, delete, and deleteAsync: project-key routes.
- `operations`: get, events, wait.
- `events`: list durable project events.
- `billing`, `members`, and `invitations`: control-plane administration.

There are currently no SDK namespaces for command execution, files, terminal sessions, connections, or port exposure.
