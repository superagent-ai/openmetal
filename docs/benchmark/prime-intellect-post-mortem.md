# Prime Intellect Sandbox Integration Post-Mortem

## Scope and evidence

On September 25, 2026, I integrated Prime Intellect VM sandboxes into Metal's provider contract. This post-mortem covers the integration experience and one live conformance run, not a performance or isolation benchmark. I reviewed Prime's [sandbox overview](https://docs.primeintellect.ai/sandboxes/overview), [SDK guide](https://docs.primeintellect.ai/sandboxes/sdk), and the Prime Python SDK's command-session and gateway implementation at [commit `ef4d176` of `PrimeIntellect-ai/prime`](https://github.com/PrimeIntellect-ai/prime/tree/ef4d17614ebfeeb6596910240609ac694d8df3f4/packages/prime-sandboxes). The fake-transport contract tests exercise create/reconciliation, command frames, binary file transfer, cost estimation, and cleanup.

With a real Prime account, `METAL_LIVE_TESTS=1 METAL_LIVE_PROVIDERS=prime pnpm --filter @openmetal/worker test:live` passed its selected live test. The run took about 7.3 seconds, including a roughly 4.1-second create, a 0.5-second command test, a 1.4-second file test, cost lookup, two deletes, and tagged-resource cleanup verification. It confirmed separate stdout/stderr, a nonzero exit, and text and binary read/write. One warm-image run does not establish cold-start distributions, upstream billing accuracy, or a benchmark ranking.

## What went well

Prime's create request has a native idempotency key, so Metal can use a deterministic key per sandbox and search by a deterministic label before retrying an uncertain create. The VM API exposes CPU, memory, disk, lifetime, and idle termination directly. Its command-session gateway carries separate stdout and stderr frames plus an exit event, while gateway uploads and downloads permit binary file transfer. The published CPU/memory/disk rates can produce a transparent, low-confidence estimate in exact micro-USD arithmetic.

## What made integration harder

The sandbox API is not listed in the platform's published OpenAPI index; the public Python SDK was the most precise reference for `/api/v1/sandbox`, gateway authentication, and Connect-protobuf framing. The first live test failed before creation because Prime's list endpoint returned `has_next` while the adapter expected `hasNext`. I fixed the response normalization, added a snake-case contract fixture, and reran the full test successfully. The live run confirmed the Connect-protobuf path, but command-session streams can lose output while disconnected. Until restart-safe replay and remotely confirmed cancellation are proven, Metal declares neither portable streaming nor cancellation. Prime's gateway uploads overwrite but do not offer portable atomic create/append, listing, deletion, or guaranteed parent creation. Pause/resume and expiring, revocable HTTP port leases are also outside this adapter's contract.

Prime's rate card explicitly expires on December 22, 2026. Billing evidence is therefore an estimate rather than a provider-reported resource charge, and the adapter returns no cost for runtime outside that rate-card window. First-launch image conversion can also hold a VM in `PENDING` for minutes; the adapter polls with a bounded deadline and leaves uncertain outcomes for reconciliation.

## Follow-up

Test first-launch image conversion, post-delete estimates against provider billing records, and repeated or failure-injected cleanup. Obtain a refreshed rate card after December 22 and evidence of replay/cancellation before upgrading the capability declaration or comparing Prime with the ten providers in the existing benchmark.

The database change only expands three provider-name check constraints. Roll forward by correcting the constraints if deployment fails. Rolling back requires confirming there are no Prime sandboxes, cost snapshots, or stored credentials before restoring the previous constraints; never delete user rows to force a rollback.

## Bottom line

Prime's VM lifecycle, commands, files, and repeated deletion worked in one live conformance run. Cost reconciliation, stream recovery, and reliability across multiple runs still need evidence before assigning a benchmark score.
