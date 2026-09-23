# Runtime API

OpenMetal exposes asynchronous process, filesystem, and leased HTTP endpoint operations for ready sandboxes. These routes are part of the project-key API; interactive PTY/terminal sessions, stdin streaming, WebSocket or SSH connections, and a general-purpose connection API are not exposed.

## Authentication and scope

Sandbox, process, filesystem, runtime-operation, and endpoint routes require:

- `Authorization: Bearer metal_sk_*`
- `X-Metal-Project-ID: prj_*`, matching the project bound to the API key

The `/v1/operations/{operation_id}` and `/events` routes require the exact project API key associated with the originating sandbox but do not require `X-Metal-Project-ID`.

IDs are project- and sandbox-scoped. A resource outside that scope is not accessible. The sandbox must be `ready` and have an active provider resource when a process, filesystem operation, or endpoint is created; otherwise the API returns `409 invalid_sandbox_state`.

Mutations return `202 Accepted` because provider work runs in the worker. Process creation and endpoint creation require `Idempotency-Key`. Filesystem write and delete and process cancellation accept an optional key. Read and list operations do not use an idempotency key. Reuse a key only with identical input, or the API returns `idempotency_mismatch`; the public contract does not guarantee a fixed retention period.

## Processes

Routes:

```text
POST /v1/sandboxes/{sandbox_id}/processes
GET  /v1/sandboxes/{sandbox_id}/processes/{process_id}
GET  /v1/sandboxes/{sandbox_id}/processes/{process_id}/events
POST /v1/sandboxes/{sandbox_id}/processes/{process_id}/actions/cancel
```

Create accepts an argv array, optional absolute `cwd`, optional environment map, `timeout_seconds`, and `max_output_bytes`. It does not invoke a public terminal or PTY API. Contract limits are:

- 1 to 4,096 arguments; each argument is at most 131,072 characters.
- Timeout defaults to 300 seconds and is limited to 1 through 3,600 seconds.
- Captured stdout plus stderr defaults to 10 MiB and is limited to 1 byte through 100 MiB. A provider may advertise a lower limit.
- Environment names are 1 through 256 characters and values are at most 16,384 characters.

The initial state is `queued`; terminal states are `succeeded`, `failed`, `cancelled`, and `timed_out`. A nonzero exit produces state `failed`, preserves `exit_code`, and uses error code `process_exit_nonzero`. `output_truncated` is true when either the provider reports truncation or OpenMetal discards stdout/stderr after `max_output_bytes`. Cancellation is provider-dependent and is only recorded as `cancelled` after the provider confirms remote termination, or when a queued process is atomically prevented from starting. A timeout is recorded as `timed_out` only when supported remote cancellation is confirmed; an unverified outcome is recorded as a failure instead. Cancelling an already terminal process returns `409 process_terminal`.

Process events have monotonically increasing positive `sequence` values and types `queued`, `started`, `stdout`, `stderr`, `exited`, `cancelled`, `timed_out`, or `failed`. Output is base64-encoded and includes a byte count and per-stream byte offset. Providers with ordered streaming persist output while the command runs. Buffered providers persist output after completion; their stdout and stderr channels remain separate, but event sequence does not represent the original cross-stream timing.

The events route returns a finite `text/event-stream` batch and closes; it is not one permanently open HTTP response. Each response contains at most 100 events and at most 1 MiB of event JSON. Supply `Last-Event-ID: <sequence>` to receive only later events, then reconnect until a terminal event arrives. The TypeScript SDK's `processes.events()` async iterable performs those reconnects and rejects sequence gaps. Process events are retained until seven days after the process completes by default and are then removed in bounded worker cleanup batches. Events for queued, running, or cancelling processes are never removed by retention cleanup, regardless of process or event age. Clients should persist output they need beyond the terminal-process retention window.

After an empty batch, the SDK async iterable fetches process status. It returns when the process is terminal, including when resuming from a sequence at or after the terminal event; otherwise it waits for the configured reconnect delay before fetching another batch.

## Filesystem

Routes:

```text
POST /v1/sandboxes/{sandbox_id}/filesystem/read
POST /v1/sandboxes/{sandbox_id}/filesystem/write
POST /v1/sandboxes/{sandbox_id}/filesystem/list
POST /v1/sandboxes/{sandbox_id}/filesystem/delete
GET  /v1/sandboxes/{sandbox_id}/runtime-operations/{runtime_operation_id}
```

Each POST returns a `runtime_operation` in `queued` state plus a `Location` header. Poll the GET route until `succeeded`, `failed`, or `cancelled`; a successful result has the same kind as the operation: `filesystem_read`, `filesystem_write`, `filesystem_list`, or `filesystem_delete`.

Portable paths are absolute, at most 4,096 characters, contain no NUL byte, and cannot contain `.` or `..` traversal segments. Read uses `offset_bytes` and `limit_bytes`, returning the same path and offset plus base64 bytes and `eof`; the default chunk is 1 MiB and the contract maximum is 10 MiB per operation. The SDK download helper validates the returned path, offset, decoded byte length, and forward progress before returning bytes. Write accepts up to 10 MiB decoded bytes with mode `create`, `overwrite`, or `append`, plus `create_parents`. List defaults to 1,000 entries and permits at most 10,000, returning `truncated`. Delete supports optional recursive removal.

Capabilities are checked by the worker. Unsupported operations, write modes, parent-directory creation, and requests above a provider's lower limit complete as failed runtime operations with `capability_unsupported` before the provider method is called; acceptance of the HTTP request is not proof the provider can perform it.

## HTTP endpoints

Routes:

```text
POST   /v1/sandboxes/{sandbox_id}/endpoints
GET    /v1/sandboxes/{sandbox_id}/endpoints?cursor=&limit=
DELETE /v1/sandboxes/{sandbox_id}/endpoints/{endpoint_id}
```

Only `http` endpoints are portable. Ports range from 1 through 65,535. Lease duration defaults to 3,600 seconds and must be from 60 through 86,400 seconds. Create returns a `provisioning` endpoint; poll the list route for `active` and a non-null URL or for `failed`. There is no single-endpoint GET or endpoint wait route.

List pagination defaults to 50 and permits 1 through 100 items. An invalid cursor returns `422 validation_error`. Only one non-revoked, non-expired endpoint may use a sandbox port; a conflict returns `409 endpoint_conflict`.

Delete returns `202` and moves an active lease toward `revoked`; repeated deletion of an already revoked or expired endpoint returns its current representation. The worker is the single project-safe expiry authority: it records `endpoint.expired`, then queues verified provider revocation. The API never performs an unscoped expiry update while listing. A provider response cannot extend the absolute lease expiry recorded when the API accepted creation, and activation is conditional so concurrent deletion or expiry wins. Endpoint states are `provisioning`, `active`, `revoking`, `revoked`, `expired`, and `failed`.

## Computer use and recordings

Computer use is capability-driven. Call `GET /v1/sandboxes/{sandbox_id}/capabilities` after a sandbox becomes ready instead of branching on its provider name. The manifest records whether the implementation is native or emulated, the available action kinds, screenshot formats and limits, and recording formats observed for that sandbox.

Portable routes are:

```text
POST /v1/sandboxes/{sandbox_id}/computer/actions
POST /v1/sandboxes/{sandbox_id}/computer/screenshots
GET  /v1/sandboxes/{sandbox_id}/recordings
POST /v1/sandboxes/{sandbox_id}/recordings
GET  /v1/sandboxes/{sandbox_id}/recordings/{recording_id}
POST /v1/sandboxes/{sandbox_id}/recordings/{recording_id}/actions/stop
```

Actions and screenshots are asynchronous runtime operations. Actions include pointer move, click, drag and scroll plus keyboard text, key and hotkey input. A successful screenshot result contains bounded base64 image bytes.

Recordings are durable resources with `starting`, `recording`, `stopping`, `stopped`, and `failed` states. MP4 output is normalized as a `sandbox_file` artifact, so clients download it through the existing chunked filesystem helper regardless of whether the provider recorded natively or an adapter used a local fallback. Request `features.computer_use` or `features.recording` during sandbox creation when routing must reject providers that cannot satisfy those capabilities.

## Current provider coverage

| Provider    | Processes                        | Filesystem                     | HTTP endpoints | Computer use       |
| ----------- | -------------------------------- | ------------------------------ | -------------- | ------------------ |
| Blaxel      | Execute; buffered output         | Read, write, list, delete      | Yes            | No                 |
| Cloudflare  | Execute and stream; no cancel    | Read/write within `/workspace` | No             | No                 |
| CodeSandbox | No                               | No                             | No             | No                 |
| Daytona     | Execute; buffered output; cancel | Read, write, list, delete      | No             | Native, MP4 record |
| E2B         | Execute and stream; no cancel    | Read, write, list, delete      | No             | No                 |
| Freestyle   | Execute; buffered output         | Read, write, list, delete      | No             | No                 |
| Modal       | Execute and stream; no cancel    | Read, write, list, delete      | No             | No                 |
| Northflank  | No                               | No                             | No             | No                 |
| Runloop     | Execute; buffered output         | Read and write                 | No             | No                 |
| Vercel      | Execute and stream; no cancel    | Read and write                 | No             | No                 |

The worker accepts both streaming and buffered process adapters. Blaxel, Daytona, Freestyle, and Runloop return output after command completion, so callers cannot react to their output while the command runs and should not infer stdout/stderr interleaving from event sequence. Daytona starts commands asynchronously and confirms cancellation by deleting the command's temporary session; its per-request HTTP timeout does not limit the overall process deadline. Deleting a Daytona session kills its process group, so each command runs under `setsid` and background processes it leaves running survive that cleanup. Cloudflare supports an omitted or empty environment but rejects non-empty environment overrides. E2B, Modal, and Vercel stream output but do not advertise confirmed process cancellation. Daytona, E2B, Freestyle, Modal, Runloop, and Vercel reject append writes; Freestyle supports only overwrite writes, and Runloop rejects parent creation. Blaxel, Daytona, E2B, Freestyle, and Modal implement file list/delete. Freestyle's native buffered exec is limited to 300 seconds.

Only Blaxel exposes portable HTTP endpoints with a verified native expiry and revocation path. If an endpoint-create job is reclaimed after exposure may have started, the worker does not call the exposure method again: it records a failed resource with an unknown provider outcome and makes a best-effort revoke when a durable lease ID was stored. Native provider expiry bounds an orphan when the crash occurred before that identity became durable. Other adapters' endpoint capabilities are disabled when live verification cannot prove the complete lease contract. See the OpenMetal skill's [provider reference](../skills/openmetal/references/providers-and-billing.md) for adapter ceilings and additional details.

Runtime outbox jobs use renewable leases with a unique lease-generation token. Runtime rows also store the current operation token, and terminal updates are compare-and-set against both state and token so a stale worker cannot publish a later result. This does not provide general restart reconciliation: a reclaimed filesystem operation is failed closed, and a reclaimed endpoint create is handled as the unknown outcome described above. A durable process execution ID can support a later cancellation attempt, but consumed output is not replayed after a worker crash.

## Errors and capability snapshots

HTTP errors use:

```json
{
  "code": "validation_error",
  "message": "Request is invalid",
  "request_id": "request-id",
  "retryable": false,
  "details": {}
}
```

Common runtime codes include `idempotency_key_required`, `idempotency_mismatch`, `invalid_sandbox_state`, `process_terminal`, `endpoint_conflict`, `capability_unsupported`, `not_found`, and `validation_error`. Provider execution failures are recorded on the process, runtime operation, or endpoint instead of changing the already returned `202`.

When a runtime call fails because the provider is unavailable or the outcome is unknown, and on each routine cost sync of a `ready` sandbox, the worker asks adapters that implement `inspect` for the provider-side sandbox state. If the provider reports the sandbox stopped, failed, or absent, the worker moves it from `ready` to `stopping` with `state_reason` `provider_stopped` and runs the existing destroy job immediately. That job records `sandbox.deleted` with the same reason and schedules the final cost sync. Daytona is currently the only adapter that implements `inspect`.

Every newly provisioned sandbox stores an observed `provider_capabilities` snapshot. Runtime resources copy that snapshot for auditability. Treat it as a guarantee for that sandbox snapshot only, not for another provider, image, or future sandbox. See the provider matrix in the OpenMetal skill's [provider reference](../skills/openmetal/references/providers-and-billing.md) for current adapter limitations.
