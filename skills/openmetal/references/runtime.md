# Processes, Filesystem, And Endpoints

Read this reference before running commands, moving files, exposing a port, resuming process output, or depending on provider runtime capabilities.

## Runtime Boundary

OpenMetal ships:

- Asynchronous argv-based processes with persisted ordered stdout/stderr events, status, timeout, exit code, and provider-dependent cancellation.
- Asynchronous binary file read, write, list, and delete operations.
- Time-limited HTTP endpoint creation, listing, expiry, and revocation.

OpenMetal does not ship an interactive PTY/terminal, streaming stdin, SSH, WebSocket, or general connection/session API. Do not invent `sandbox.exec()`, `sandbox.files`, `sandbox.connect()`, or `sandbox.ports`; use the exact `MetalClient` namespaces and CLI commands below.

Sandbox and sandbox-runtime routes require `Authorization: Bearer metal_sk_*` and `X-Metal-Project-ID: prj_*` for the same project. `/v1/operations/{operation_id}` and its `/events` route require the exact project API key associated with the originating sandbox but do not require the project header. The sandbox must be `ready`; submission otherwise fails with `invalid_sandbox_state`.

## Processes

HTTP routes:

```text
POST /v1/sandboxes/{sandbox_id}/processes
GET  /v1/sandboxes/{sandbox_id}/processes/{process_id}
GET  /v1/sandboxes/{sandbox_id}/processes/{process_id}/events
POST /v1/sandboxes/{sandbox_id}/processes/{process_id}/actions/cancel
```

SDK methods:

```text
metal.processes.create(sandboxId, input, options?)
metal.processes.get(sandboxId, processId, options?)
metal.processes.events(sandboxId, processId, options?) -> AsyncIterable<ProcessEvent>
metal.processes.cancel(sandboxId, processId, options?)
```

CLI commands:

```bash
openmetal sandbox exec <sandbox-id> --cwd /workspace -- node app.js
openmetal process get <sandbox-id> <process-id>
openmetal process events <sandbox-id> <process-id> --after 0
openmetal process cancel <sandbox-id> <process-id> --yes
```

Process creation returns `202` and requires `Idempotency-Key`; the SDK and CLI generate one when omitted. Reusing a key with different input returns `idempotency_mismatch`; the API does not publicly guarantee a fixed retention period. Request limits are 4,096 arguments, 131,072 characters per argument, 1 through 3,600 seconds timeout (default 300), and 1 byte through 100 MiB captured stdout plus stderr (default 10 MiB). Providers may impose lower output limits.

States are `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, and `timed_out`. A nonzero exit is `failed` with `process_exit_nonzero` and the original exit code. Event types are `queued`, `started`, `stdout`, `stderr`, `exited`, `cancelled`, `timed_out`, and `failed`.

The events HTTP response is one finite SSE batch. Pass `Last-Event-ID` to request later events. `processes.events()` repeatedly fetches batches, verifies contiguous sequences, and stops after a terminal event. After an empty batch it fetches process status, returns if terminal, or waits for the reconnect delay before fetching again. Save the last processed sequence when restarting a consumer. Output payloads are base64 with `byte_length` and a per-stream `stream_offset_bytes`.

A resume cursor at or after the terminal event therefore terminates after the empty batch and terminal status check.

The CLI decodes stdout/stderr to their matching local streams and exits with the remote exit code without adding synthetic stderr for a nonzero exit. Under `--json`, it buffers events and emits one `{ process, events }` document instead. If streaming fails after acceptance, it reports the accepted process ID and the stable idempotency key used for creation.

## Filesystem

HTTP routes:

```text
POST /v1/sandboxes/{sandbox_id}/filesystem/read
POST /v1/sandboxes/{sandbox_id}/filesystem/write
POST /v1/sandboxes/{sandbox_id}/filesystem/list
POST /v1/sandboxes/{sandbox_id}/filesystem/delete
GET  /v1/sandboxes/{sandbox_id}/runtime-operations/{runtime_operation_id}
```

SDK methods:

```text
metal.filesystem.read(sandboxId, input, options?)
metal.filesystem.write(sandboxId, input, options?)
metal.filesystem.list(sandboxId, input, options?)
metal.filesystem.delete(sandboxId, input, options?)
metal.filesystem.upload(sandboxId, path, data, options?)
metal.filesystem.download(sandboxId, path, options?)
metal.runtimeOperations.get(sandboxId, runtimeOperationId, options?)
metal.runtimeOperations.wait(operationOrId, options?)
```

CLI commands:

```bash
openmetal file upload <sandbox-id> <local-path-or-> <remote-path>
openmetal file download <sandbox-id> <remote-path> [local-path]
openmetal file list <sandbox-id> <path>
openmetal file delete <sandbox-id> <path> --yes
```

`file upload` has alias `file write`; `file download` has alias `file read`. Upload/download and the SDK binary helpers preserve bytes. Upload uses one stable idempotency key and reports it with the accepted runtime-operation ID if waiting fails; replay an append only with that same key. Download validates every result path and offset plus byte length and forward progress before returning or writing bytes. A CLI download without a local path writes raw stdout, or `data_base64` under `--json`.

Every filesystem POST returns `202` with a queued `runtime_operation` and `Location`; wait for `succeeded`, `failed`, or `cancelled`. `runtimeOperations.wait()` defaults to 180 seconds and 500 millisecond polling. When waiting by ID rather than an operation object, pass `{ sandboxId }`.

Paths must be absolute, at most 4,096 characters, contain no NUL byte, and contain no `.` or `..` traversal segment. Read chunks default to 1 MiB and are at most 10 MiB. Decoded writes are at most 10 MiB and use `create`, `overwrite`, or `append`. Lists default to 1,000 and allow at most 10,000 entries. Provider-specific capability checks happen asynchronously; inspect the completed operation.

## HTTP Endpoints

HTTP routes:

```text
POST   /v1/sandboxes/{sandbox_id}/endpoints
GET    /v1/sandboxes/{sandbox_id}/endpoints?cursor=&limit=
DELETE /v1/sandboxes/{sandbox_id}/endpoints/{endpoint_id}
```

SDK methods are:

```text
metal.endpoints.create(sandboxId, input, options?)
metal.endpoints.list(sandboxId, options?)
metal.endpoints.revoke(sandboxId, endpointId, options?)
```

CLI commands are:

```bash
openmetal endpoint expose <sandbox-id> --port 8080 --lease-seconds 3600
openmetal endpoint list <sandbox-id> --limit 50
openmetal endpoint revoke <sandbox-id> <endpoint-id> --yes
```

Create requires an idempotency key; the SDK and CLI generate one. It returns `202` and normally state `provisioning`, not a ready URL. There is no single-endpoint GET or wait helper: poll the list route for `active` with a URL or `failed`.

Only `http` is accepted. Ports are 1 through 65,535 and leases are 60 through 86,400 seconds, subject to provider restrictions. List defaults to 50 and permits 1 through 100. One live lease is allowed per sandbox port. Expiry is asynchronous and endpoint states are `provisioning`, `active`, `revoking`, `revoked`, `expired`, and `failed`.

## Runtime Failures

`202 Accepted` means work was queued, not that the provider supports or completed it. Capability or provider failures appear later:

- Processes end in `failed` with an error object.
- Filesystem runtime operations end in `failed`.
- Endpoints enter `failed`.

`capability_unsupported` covers absent provider methods and provider-specific limits. Preserve `provider_capabilities` snapshots when returned, but do not treat them as guarantees for a different sandbox. See [providers-and-billing.md](providers-and-billing.md) for the current matrix.
