# ADR 014: GPU jobs as a separate resource

## Status

Accepted

## Context

Customers need to run training, fine-tuning, batch inference, and evaluation on GPUs. GPU
providers expose different lifecycles: run-to-completion jobs, long-lived instances, and
autoscaled deployments. No provider supports all three natively, and none of them matches the
sandbox lifecycle of ready, exec, pause, and destroy.

`AGENT.md` requires future GPU products to reuse control-plane infrastructure without being forced
through the sandbox lifecycle or API.

## Decision

- GPU jobs are a first-class resource at `/v1/gpu/jobs` with their own table, states, and outbox
  jobs (`gpu_job.submit`, `gpu_job.monitor`, `gpu_job.cancel`, `gpu_job.cost.sync`). A job runs one
  OCI image and argv command to completion. Instances and deployments are later, separate
  resources.
- `operations`, `provider_attempts`, `provider_cost_snapshots`, and `usage_charges` reference
  exactly one of a sandbox or a GPU job, enforced by `num_nonnulls(...) = 1` checks. Operations,
  provider attempts, cost provenance, the ledger, spend limits, events, and webhooks therefore
  behave identically for both resources.
- Provider adapters implement `GpuJobProvider` in `@openmetal/provider-core`: submit, reconcile an
  uncertain submit, status, resumable log reads, cancel, and cost. The GPU catalog and published
  rate cards live beside that interface so the API preflight and the adapter price from one table.
- Modal is the first provider. Jobs are Modal GPU Sandboxes running the job command, created under a
  dedicated app and named and tagged by the Metal job ID so a retried submit adopts the running
  Sandbox and an uncertain submit can be reconciled. Exit status comes from `sandboxWait`, logs
  from `sandboxGetLogs` with a stored per-stream cursor, and cost from `sandboxGetResourceUsage`
  priced at the requested GPU type, which is how Modal bills automatic upgrades. These calls use
  the pinned JS SDK's control-plane client.
- The worker polls instead of holding a stream: one recurring monitor row per job reads a bounded
  log batch, checks status, and syncs cost about every 30 seconds, then reschedules itself. A
  rescheduled row moves to the back of the queue so a cancel on the same lock is not starved.
- Job secrets are stored as one Supabase Vault secret, injected through a provider secret at
  submit, never returned, and purged when the job reaches a terminal state.
- Managed jobs cannot mount provider volumes, because volumes would persist in OpenMetal's
  provider workspace, outside billing and visible to other tenants by name. Volumes are allowed
  with Modal BYOK credentials.
- `limits.max_cost_usd`, the organization spend limit, and a deadline job at
  `max_runtime_seconds` plus a grace period all cancel through the same path.
- Modal's usage meter lags by a minute or more, so managed cost is charged from elapsed container
  time at the job's reserved size and region multiplier (its stored hourly estimate) whenever that
  exceeds the metered amount. `max_cost_usd` is checked against the elapsed-time cost on every
  monitor pass. The settlement ten minutes after completion charges the higher of the metered amount
  and Modal's own task window (container start to finish from `sandboxList`) at the same rate, and
  posts a correction. The floor exists because `sandboxGetResourceUsage` undercounted a 114-second
  job as 8 GPU seconds in end-to-end testing, while matching container time for others; CPU or
  memory bursts above the reservation are still billed through the metered amount.
- Organization usage totals include GPU job cost, and the usage contract lists GPU jobs in
  `top_gpu_jobs` and `gpu_job_activity`.
- A job is `provisioning` from submission until the provider places a container, and `running`
  from then on. Modal reports placement through `sandboxGetTaskId`; for jobs that exit between two
  monitor passes the worker reads the task start time from `sandboxList`. `max_runtime_seconds`
  counts from container start, `lifecycle.max_start_seconds` (default 30 minutes) from creation,
  and the provider timeout covers both, capped at Modal's 24 hours.
- Region placement uses Modal's region names. Pinned jobs store the price multiplier (1.15 broad,
  1.75 narrow, the lower one for mixed lists) and apply it to metered cost, the estimate, and
  `max_cost_usd`.
- Managed jobs are gated when they are claimed, under one advisory lock: a per-organization GPU
  cap (`WORKER_GPU_JOB_MAX_MANAGED_GPUS_PER_ORGANIZATION`, default 8), an optional pool cap
  (`WORKER_GPU_JOB_MAX_MANAGED_GPUS`, set to the Modal workspace limit), and a funding check that
  the balance covers 15 minutes of the organization's active managed GPU jobs at their estimated
  hourly rate. The API applies the same funding check at create. Waiting jobs stay `requested`
  with a `waiting_for_*` reason and fail at their start deadline.
- Registry and bucket-mount credentials share the job's Vault secret (a versioned payload beside
  the environment secrets) and reach Modal only as ephemeral secrets. Bucket mounts work for
  managed jobs because the bucket belongs to the customer.
- A sweep every 10 minutes terminates Modal Sandboxes in the managed app whose job is terminal,
  missing, or owned by a different Sandbox. It only touches Sandboxes tagged with the worker's
  `METAL_ENVIRONMENT`, and it runs, like the daily reconciliation, only in production unless
  `WORKER_GPU_JOB_SWEEPS` says otherwise, so local workers sharing the Modal app cannot stop
  production jobs.
- A daily job compares metered managed cost with Modal's workspace billing report for the managed
  app and stores the result in `gpu_cost_reconciliations`, logging an error when drift exceeds 2%
  and $0.50. The report is itemized per app and hour, not per Sandbox, so it detects rate card or
  multiplier drift but does not settle individual jobs.
- Managed GPU jobs can use a separate Modal workspace (`MODAL_GPU_TOKEN_ID`,
  `MODAL_GPU_TOKEN_SECRET`, `MODAL_GPU_ENVIRONMENT`) so their concurrency and billing are isolated
  from sandboxes and other workloads.

## Consequences

- Adding a GPU provider requires an adapter, catalog offers, and a registry entry. Provider names
  are enumerated in the public contracts (`GpuJobProviderSchema` and the usage schemas), so a new
  provider also adds its name there, regenerates OpenAPI, and ships an SDK release. A provider not
  already in the `provider` check constraints on the shared cost tables also needs a migration.
- Modal's control-plane gRPC calls are not a public API, and Modal has no public REST API to use
  instead. The adapter is covered by contract tests with a fake client and opt-in live tests
  (`METAL_LIVE_TESTS=1`) that also run daily in the `modal-gpu-live` workflow, and the SDK version
  is pinned exactly.
- A job's cost can change slightly at settlement, usually up by unreserved CPU and memory or down
  by the seconds between the container's real exit and the worker observing it. `max_cost_usd`
  can be exceeded by the provider's stop latency and by unreserved usage.
- Rollback: the migration is additive apart from making `sandbox_id` nullable on the four shared
  tables. Rolling back code leaves GPU rows unreferenced; restoring `not null` requires deleting GPU
  job rows first.
