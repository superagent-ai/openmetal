# GPU Jobs

Read this reference before creating, monitoring, or cancelling a GPU job.

## Model

A GPU job runs one OCI image with an argv `command` on `gpu.count` GPUs of one `gpu.type` until the command exits. It is a separate resource from a sandbox: there are no process, filesystem, endpoint, pause, or resume routes. GPU jobs run on Modal, with managed OpenMetal credits or the organization's Modal BYOK credentials.

## Routes And SDK

| Purpose      | Route                                       | SDK                                 | CLI                                    |
| ------------ | ------------------------------------------- | ----------------------------------- | -------------------------------------- |
| GPU catalog  | `GET /v1/gpu/types`                         | `metal.gpu.types()`                 | `openmetal gpu types`                  |
| Create       | `POST /v1/gpu/jobs` with `Idempotency-Key`  | `gpuJobs.createAsync()`, `create()` | `openmetal gpu job create ... -- argv` |
| Get and list | `GET /v1/gpu/jobs/{id}`, `GET /v1/gpu/jobs` | `gpuJobs.get()`, `list()`           | `openmetal gpu job get`, `list`        |
| Logs         | `GET /v1/gpu/jobs/{id}/logs` (SSE batches)  | `gpuJobs.logs()` async iterator     | `openmetal gpu job logs`               |
| Wait         | poll `GET /v1/gpu/jobs/{id}`                | `gpuJobs.wait()`                    | `openmetal gpu job wait`               |
| Cancel       | `POST /v1/gpu/jobs/{id}/actions/cancel`     | `gpuJobs.cancelAsync()`, `cancel()` | `openmetal gpu job cancel`             |

All job routes use the project API key and `X-Metal-Project-ID`. `GET /v1/gpu/types` needs no authentication.

## Request

```json
{
  "provider": "auto",
  "source": {
    "kind": "oci_image",
    "image": "pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime",
    "command": ["python", "train.py"],
    "working_dir": "/workspace"
  },
  "gpu": { "type": "nvidia-h100", "count": 1 },
  "resources": { "vcpu": 8, "memory_mb": 65536 },
  "placement": { "regions": ["us"] },
  "lifecycle": { "max_runtime_seconds": 3600, "max_start_seconds": 1800 },
  "limits": { "max_cost_usd": "10.00" },
  "environment": { "EPOCHS": "3" },
  "secrets": { "HF_TOKEN": "..." },
  "metadata": { "run": "r-42" }
}
```

- GPU types: `nvidia-t4`, `nvidia-l4`, `nvidia-a10` (max 4), `nvidia-l40s`, `nvidia-a100-40gb`, `nvidia-a100-80gb`, `nvidia-rtx-pro-6000`, `nvidia-h100`, `nvidia-h200`, `nvidia-b200`, `nvidia-b300`. Check `GET /v1/gpu/types` for current limits and rates.
- `command` runs without a shell. Use `["sh", "-c", "..."]` only when shell syntax is required.
- `max_runtime_seconds` is 60 to 86,400, is required, and counts from container start. `max_start_seconds` (default 1,800) bounds the wait for GPUs from creation.
- `placement.regions` pins the job to Modal regions (`us`, `eu`, `ap` are broad; `us-west`, `jp`, and others are narrow). Pinned jobs cost 1.15× (broad) or 1.75× (narrow) and may wait longer for GPUs. Leave it out unless the user needs a region.
- `source.registry_auth` pulls private images: `basic` (username, password), `aws_ecr` (access keys and region), or `gcp_artifact_registry` (service account JSON). Credentials are never returned.
- `mounts` mounts the user's own S3, R2, or GCS bucket (`kind: "bucket"`, `provider`, `bucket`, `mount_path`, `credentials`, and `endpoint_url` for R2). Use it for checkpoints and outputs; the container filesystem is discarded on exit. Mounts cannot append to files.
- `resources` is optional. Omit it to pay only for CPU and memory actually used.
- `secrets` are write-only, encrypted at rest, and deleted when the job finishes. The job lists only `requested.secret_names`. A name cannot appear in both `environment` and `secrets`.
- `provider_options.modal.volumes` is accepted only with Modal BYOK credentials.

## States

`requested` → `provisioning` → `running` → `succeeded`, `failed`, `timed_out`, or `cancelled`. `provisioning` includes waiting for GPUs after the provider accepted the job (`submitted_at`); `running` starts when the container starts (`started_at`). A `requested` job with `state_reason` `waiting_for_organization_gpu_limit` or `waiting_for_gpu_capacity` is queued and starts on its own. `cancelling` follows a cancel or a limit. `provision_unknown` means the provider's submit answer was lost and OpenMetal is reconciling; do not create a replacement job while it is set.

Read `state_reason` and `failure` for why a job ended. `exit_code_nonzero` carries `exit_code`. `provider_terminated` usually means preemption; OpenMetal does not restart the job, so resubmit and resume from a checkpoint. `max_cost_reached` and `insufficient_credits` are cancellations by OpenMetal. `start_deadline_exceeded` means no GPU started in time; retry later, with a larger `max_start_seconds`, or without a narrow region.

## Logs

Log batches contain `stdout`, `stderr`, and `truncated` events with base64 data and per-stream byte offsets. Resume with `Last-Event-ID` and stop once a batch is empty and the job has `logs_complete: true`. Up to 32 MiB is stored per job, kept for 7 days.

## Billing

Managed jobs pay the provider's published per-second rates with no markup: per-GPU rate times GPU seconds, plus CPU and memory, times the region multiplier. `pricing.estimated_hourly_cost_usd` shows the expected rate. A managed create returns `402 insufficient_credits` with `details.required_usd` unless the balance covers 15 minutes of the organization's managed GPU jobs; each organization runs at most 8 managed GPUs at once. Cost is charged every 30 seconds from elapsed container time and settles to the provider's metered usage 10 minutes after the job finishes, which can move it slightly. `max_cost_usd` is checked every few seconds against elapsed time, so the job stops close to the limit.

## Rules

1. Confirm the GPU type and count with `openmetal gpu types` before creating.
2. Set both `max_runtime_seconds` and `limits.max_cost_usd`.
3. Pass tokens only through `secrets` or `--secret-env`; never echo them in commands or logs.
4. Retain `gpu_job.id` and `operation.id`. Retry an uncertain create with the same `Idempotency-Key`.
5. Stream logs or call `wait` rather than polling in a tight loop.
6. Cancel jobs the user no longer needs; a `409 gpu_job_terminal` means it already finished.
