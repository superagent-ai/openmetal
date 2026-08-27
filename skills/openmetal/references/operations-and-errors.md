# Operations And Errors

Read this reference when waiting for a lifecycle mutation, interpreting states, recovering after a timeout, or deciding whether a retry is safe.

## Asynchronous Mutations

Create, pause, resume, and destroy produce a sandbox mutation:

```json
{
  "sandbox": {
    "id": "sbx_example",
    "state": "requested"
  },
  "operation": {
    "id": "op_example",
    "type": "sandbox_create",
    "state": "queued"
  }
}
```

An accepted mutation is not completion. Persist both IDs, then poll or wait for the operation.

Operation types are:

```text
sandbox_create, sandbox_pause, sandbox_resume, sandbox_destroy
```

Operation states are:

```text
queued, running, reconciling, succeeded, failed, cancelled
```

Only `succeeded`, `failed`, and `cancelled` are terminal. `reconciling` means the provider result is uncertain; do not create a replacement sandbox or report failure while reconciliation is active. Current code may leave an operation in `reconciling` indefinitely because no follow-up reconciliation job is scheduled after an inconclusive immediate check. There is no public reconciliation command, so stop after a bounded wait and escalate to an OpenMetal operator with the operation and sandbox IDs.

## Sandbox States

```text
requested
routing
provisioning
provision_unknown
ready
pausing
paused
resuming
runtime_unknown
stopping
stopped
failed
cleanup_pending
cleanup_failed
```

Use the operation as the source of truth for mutation completion and the sandbox as the source of truth for current resource state. A successful create should end with a `ready` sandbox. A successful destroy should end with `stopped`.

Do not request pause unless the sandbox is ready and its provider supports pause. Do not request resume unless it is paused and the provider supports resume.

## Event Batches

Operation event types are:

```text
queued
routing
attempt_started
attempt_failed
reconciling
state_changed
completed
```

Events have increasing positive sequence numbers. The events endpoint returns finite SSE batches and accepts the last sequence through `Last-Event-ID` in the SDK or `--after` in the CLI. Save the last processed sequence before polling again.

## Error Envelope

API errors use this safe shape:

```json
{
  "code": "validation_error",
  "message": "Request is invalid",
  "request_id": "request-id",
  "retryable": false,
  "details": {}
}
```

Log `code`, `message`, `request_id`, and `retryable`. Review `details` before logging because it can contain user-controlled values. Never log request headers, credentials, environment values, or secret references.

## Common Errors

| Code                            | Meaning                                      | Response                                                                                 |
| ------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `unauthenticated`               | Missing, expired, or invalid token           | Refresh the appropriate token; verify project-key versus user-session scope.             |
| `forbidden`                     | Credential lacks access                      | Verify organization/project membership and that the key belongs to the selected project. |
| `validation_error`              | Request does not match the contract          | Correct the request; do not retry unchanged.                                             |
| `not_found`                     | Resource is absent or inaccessible           | Verify ID and project scope. Do not assume cross-project visibility.                     |
| `conflict`                      | Resource state or request conflicts          | Fetch current sandbox and operation state before deciding.                               |
| `idempotency_mismatch`          | A key was reused with different input        | Use the original input or a new key for a genuinely new operation.                       |
| `insufficient_credits`          | Managed balance is not positive              | Fund the organization or intentionally choose eligible BYOK.                             |
| `capability_unsupported`        | No candidate can meet a known requirement    | Relax the requirement or choose a compatible provider.                                   |
| `no_eligible_provider`          | Routing found no usable provider             | Check source support, credentials, billing, and fallback candidates.                     |
| `provider_auth_error`           | Upstream credential failed                   | Fix the provider credential; do not fan out automatically.                               |
| `provider_quota_exceeded`       | Upstream quota is exhausted                  | Increase quota or select another intentionally configured provider.                      |
| `provider_capacity_unavailable` | Provider lacks capacity                      | Retry when marked retryable or allow safe fallback.                                      |
| `provider_unavailable`          | Provider service is unavailable              | Retry with backoff when marked retryable.                                                |
| `provider_unknown_outcome`      | Creation may or may not have happened        | Wait for reconciliation; do not create a duplicate.                                      |
| `invalid_sandbox_state`         | Action is invalid for current state          | Fetch the sandbox and choose an action valid for that state.                             |
| `unsupported_operation`         | Provider cannot perform the lifecycle action | Choose a supported provider or skip the action.                                          |
| `timeout`                       | A request deadline elapsed                   | Check the operation before retrying a mutation.                                          |
| `service_unavailable`           | OpenMetal is temporarily unavailable         | Retry safe reads with bounded backoff.                                                   |

Runtime may emit additional string error codes. Preserve unknown codes rather than converting them to a known code.

## Retry Decision

For reads:

1. Retry only when `retryable` is true.
2. Use bounded exponential backoff with jitter.
3. Keep an overall deadline.

For sandbox creation:

1. Generate and persist an idempotency key before the first attempt.
2. If the response is lost, inspect the known operation or retry with the same key and identical input.
3. Never retry with a fresh key merely because the first request timed out.
4. Stop and wait when the operation or sandbox enters an unknown or reconciling state.
5. Do not automatically retry validation, authentication, capability, or invalid-state failures.

For pause, resume, and destroy, do not automatically resubmit after a lost response. Their idempotency headers are not currently enforced by the API. A duplicate in-flight request can create an operation that never completes. Retain the original operation ID and fetch the current sandbox state before deciding what to do next.

## Current Compatibility Issues

- Operation authorization is tied to the exact project API key that created the sandbox. Use the same key for operation polling; another valid key for the project can receive `not_found`.
- Provider adapters can persist resolved resource keys in camel case while the public response schema expects snake case. Once a sandbox has resolved resources, SDK and CLI reads can fail with `internal_error: malformed metal api response` even though provisioning succeeded.
- `createAsync()` returns IDs before resolved resources are populated, but lifecycle mutation responses can fail validation before returning their new operation ID. If response validation fails after a mutation request, assume the action may have been accepted, do not resubmit it, and escalate when current state cannot be read safely.
- The API does not consistently enforce Daytona's advertised pause capability. Treat Daytona pause as unreliable until the implementation is corrected.

## Cleanup Failures

`cleanup_pending` means cleanup is durable and still being attempted. `cleanup_failed` means cleanup did not complete successfully and requires operational attention. Do not report either state as stopped, and do not discard the sandbox ID needed for remediation.
