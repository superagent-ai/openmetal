import {
  chargeUsageDelta,
  createStripeGateway,
  evaluateAutoTopup,
  enforceSpendLimit,
  type StripeGateway,
} from "@openmetal/billing";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  claimOutboxJobs,
  insertDomainEventAndBroadcast,
  ownsOutboxJobLease,
  operationEvents,
  operations,
  outboxJobs,
  providerAttempts,
  providerCostSnapshots,
  renewOutboxJobLease,
  runtimeOperations,
  sandboxEndpoints,
  sandboxProcesses,
  sandboxRecordings,
  sandboxes,
  withTransaction,
  type ClaimedJob,
  type MetalDb,
  type OutboxLease,
} from "@openmetal/db";
import { OutboxJobPayloadSchema, projectTopic, type OutboxJobPayload } from "@openmetal/events";
import { createLogger, redactString } from "@openmetal/logger";
import {
  ProviderError,
  resolveMetalEnvironment,
  resolveProviderResources,
  type ProviderComputerRecording,
  type ProviderCreateSandboxInput,
  type ProviderExecEvent,
  type ProviderRuntimeCapabilities,
  type ProviderSandboxInspection,
  type ProviderSandboxState,
  type SandboxProvider,
  type SandboxProviderName,
} from "@openmetal/provider-core";
import type { WorkerEnv } from "./env.js";
import {
  deliverWebhookOnce,
  runWithConcurrency,
  settleWebhookJob,
  webhookUrlPolicyForEnvironment,
} from "./webhooks.js";
import {
  getByokProviderByCredentialId,
  listOrganizationByokProviders,
} from "./provider-credentials.js";
import type { BroadcastPublisher } from "./publisher.js";

type SandboxProviders = Partial<Record<SandboxProviderName, SandboxProvider>>;

class OutboxLeaseLostError extends Error {
  constructor() {
    super("outbox lease ownership was lost");
    this.name = "OutboxLeaseLostError";
  }
}

type JobLeaseGuard = {
  token: string;
  assertOwned(): Promise<void>;
  stop(): void;
};

function createJobLeaseGuard(
  db: MetalDb,
  job: ClaimedJob,
  workerId: string,
  leaseMs: number,
): JobLeaseGuard {
  if (!job.leaseToken) throw new Error("claimed outbox job has no lease token");
  const lease: OutboxLease = {
    jobId: job.id,
    workerId,
    leaseToken: job.leaseToken,
    leaseMs,
  };
  let stopped = false;
  let lost = false;
  let renewal: Promise<void> | undefined;
  const renew = () => {
    if (stopped || renewal) return;
    renewal = renewOutboxJobLease(db, lease)
      .then((owned) => {
        if (!owned) lost = true;
      })
      .catch(() => {
        lost = true;
      })
      .finally(() => {
        renewal = undefined;
      });
  };
  const timer = setInterval(renew, Math.max(250, Math.floor(leaseMs / 3)));
  timer.unref();
  return {
    token: lease.leaseToken,
    async assertOwned() {
      if (lost || !(await ownsOutboxJobLease(db, lease))) {
        lost = true;
        throw new OutboxLeaseLostError();
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function backoffMs(attempt: number, base: number): number {
  const exp = Math.min(base * 2 ** Math.max(attempt - 1, 0), 30_000);
  return Math.round(exp * (0.5 + Math.random()));
}

function northflankBillingAvailableAt(measuredThrough: Date): Date {
  const hourMs = 60 * 60_000;
  const nextHour = (Math.floor(measuredThrough.getTime() / hourMs) + 1) * hourMs;
  return new Date(nextHour + 10 * 60_000);
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return redactString(error.message.slice(0, 500));
  }
  return "unknown error";
}

async function appendOperationEvent(
  db: MetalDb,
  operationId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  const rows = await db
    .select({ sequence: operationEvents.sequence })
    .from(operationEvents)
    .where(eq(operationEvents.operationId, operationId));
  await db.insert(operationEvents).values({
    operationId,
    sequence: rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1,
    type,
    data,
  });
}

async function setOperationState(
  db: MetalDb,
  operationId: string | undefined,
  state: string,
  error?: Record<string, unknown> | null,
) {
  if (!operationId) return;
  const now = new Date();
  const terminal = ["succeeded", "failed", "cancelled"].includes(state);
  await db
    .update(operations)
    .set({
      state,
      error,
      retryable: Boolean(error?.retryable),
      updatedAt: now,
      completedAt: terminal ? now : null,
    })
    .where(eq(operations.id, operationId));
  await appendOperationEvent(db, operationId, terminal ? "completed" : "state_changed", { state });
}

function classifyProviderFailure(error: unknown): {
  kind: string;
  retryable: boolean;
  fallbackSafe: boolean;
  unknown: boolean;
} {
  if (error instanceof ProviderError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      fallbackSafe: ["capacity", "unavailable", "timeout_absent"].includes(error.kind),
      unknown: error.kind === "unknown_outcome",
    };
  }
  const message = safeError(error).toLowerCase();
  if (/401|403|auth/.test(message)) {
    return { kind: "provider_auth_error", retryable: false, fallbackSafe: false, unknown: false };
  }
  if (/429|capacity|quota/.test(message)) {
    return {
      kind: "provider_capacity_unavailable",
      retryable: true,
      fallbackSafe: true,
      unknown: false,
    };
  }
  if (
    /timeout|abort|fetch failed|network|econn|enotfound|eai_again|socket|terminated/.test(message)
  ) {
    return {
      kind: "provider_unknown_outcome",
      retryable: true,
      fallbackSafe: false,
      unknown: true,
    };
  }
  if (/500|502|503|unavailable/.test(message)) {
    return { kind: "provider_unavailable", retryable: true, fallbackSafe: true, unknown: false };
  }
  return { kind: "provider_error", retryable: false, fallbackSafe: false, unknown: false };
}

async function scheduleCostSync(tx: MetalDb, sandboxId: string, availableAt: Date, final: boolean) {
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "sandbox.cost.sync",
      dedupeKey: `sandbox:cost:${sandboxId}:${availableAt.getTime()}:${final}`,
      payload: {
        job_type: "sandbox.cost.sync",
        sandbox_id: sandboxId,
        final,
      },
      availableAt,
    })
    .onConflictDoNothing();
}

async function recordSandboxEvent(
  tx: MetalDb,
  sandbox: typeof sandboxes.$inferSelect,
  type:
    | "sandbox.ready"
    | "sandbox.paused"
    | "sandbox.resumed"
    | "sandbox.cost_updated"
    | "sandbox.failed"
    | "sandbox.deleted"
    | "process.started"
    | "process.completed"
    | "process.cancelled"
    | "process.failed"
    | "runtime_operation.completed"
    | "runtime_operation.failed"
    | "endpoint.created"
    | "endpoint.revoked"
    | "endpoint.expired"
    | "endpoint.failed",
  data: Record<string, unknown>,
) {
  await insertDomainEventAndBroadcast(tx, {
    type,
    organizationId: sandbox.organizationId,
    projectId: sandbox.projectId,
    actorId: sandbox.createdBy,
    data: { sandbox_id: sandbox.publicId, ...data },
    occurredAt: new Date(),
    topic: projectTopic(`prj_${sandbox.projectId.replaceAll("-", "")}`),
  });
}

async function provisionSandbox(
  db: MetalDb,
  providers: SandboxProviders,
  sandboxId: string,
  operationId: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (
    !sandbox ||
    sandbox.status === "ready" ||
    sandbox.status === "stopping" ||
    sandbox.status === "stopped"
  ) {
    return;
  }
  await setOperationState(db, operationId, "running");
  const fallback = sandbox.fallback as { providers?: SandboxProviderName[]; max_attempts?: number };
  const byokProviders = await listOrganizationByokProviders(db, sandbox.organizationId);
  const configuredProviders = [
    ...new Set([
      ...(Object.keys(byokProviders) as SandboxProviderName[]),
      ...(Object.keys(providers) as SandboxProviderName[]),
    ]),
  ];
  const fallbackProviders = fallback.providers ?? [];
  const candidates = (
    sandbox.primaryProvider === "auto"
      ? [
          ...fallbackProviders,
          ...configuredProviders.filter((provider) => !fallbackProviders.includes(provider)),
        ]
      : [sandbox.primaryProvider as SandboxProviderName, ...fallbackProviders]
  ).slice(0, fallback.max_attempts ?? 9);
  const source = sandbox.source as ProviderCreateSandboxInput["source"];
  const environmentSource = resolveMetalEnvironment(source);
  const requested = sandbox.resourceRequirements as {
    vcpu: number;
    memory_mb: number;
    disk_mb?: number;
    architecture?: "x86_64" | "arm64" | "any";
  };
  const lifecycle = sandbox.lifecycle as {
    runtime_timeout_seconds: number;
    idle_timeout_seconds?: number;
    on_runtime_timeout?: "destroy" | "pause";
    on_idle_timeout?: "destroy" | "pause";
  };
  const allOptions = sandbox.providerOptions as Record<string, Record<string, unknown> | undefined>;

  for (const [attemptIndex, providerName] of candidates.entries()) {
    const byokProvider = byokProviders[providerName];
    const provider = byokProvider ? byokProvider.provider : providers[providerName];
    const providerCredentialId = byokProvider?.credentialId ?? null;
    const options = allOptions[providerName] ?? {};
    const [attempt] = await db
      .insert(providerAttempts)
      .values({
        operationId,
        sandboxId: sandbox.id,
        attemptIndex,
        provider: providerName,
        providerCredentialId,
        state: "running",
        startedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [providerAttempts.operationId, providerAttempts.attemptIndex],
        set: {
          providerCredentialId,
          state: "running",
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    await appendOperationEvent(db, operationId, "attempt_started", {
      attempt_index: attemptIndex,
      provider: providerName,
    });
    if (!provider) {
      const error = `${providerName} sandbox provider is not configured`;
      await db
        .update(providerAttempts)
        .set({ state: "failed", errorCode: "provider_auth_error", errorMessage: error })
        .where(eq(providerAttempts.id, attempt!.id));
      continue;
    }
    if (provider.capabilities.sources && !provider.capabilities.sources.includes(source.kind)) {
      await db
        .update(providerAttempts)
        .set({
          state: "failed",
          errorCode: "capability_unsupported",
          errorMessage: `${providerName} does not support ${source.kind} sources`,
          outcome: "ineligible",
          completedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      continue;
    }
    if (!providerCredentialId && !provider.capabilities.cost) {
      await db
        .update(providerAttempts)
        .set({
          state: "failed",
          errorCode: "capability_unsupported",
          errorMessage: `${providerName} does not expose durable cost for managed billing`,
          outcome: "ineligible",
          completedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      continue;
    }
    if (
      !supportsRequestedFeatures(
        provider.capabilities.runtime,
        sandbox.features as Record<string, unknown>,
        provider.capabilities.resume === true,
      )
    ) {
      await db
        .update(providerAttempts)
        .set({
          state: "failed",
          errorCode: "capability_unsupported",
          errorMessage: `${providerName} does not support the requested portable features`,
          outcome: "ineligible",
          completedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      continue;
    }
    try {
      const resolved = resolveProviderResources(
        providerName,
        {
          vcpu: requested.vcpu,
          memoryMb: requested.memory_mb,
          diskMb: requested.disk_mb,
          architecture: requested.architecture ?? "any",
        },
        options,
      );
      const remote = await provider.create({
        metalSandboxId: sandbox.publicId,
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        language: environmentSource.language,
        image: environmentSource.image ?? sandbox.image ?? undefined,
        ttlMinutes: Math.ceil(lifecycle.runtime_timeout_seconds / 60),
        source,
        resources: {
          vcpu: requested.vcpu,
          memoryMb: requested.memory_mb,
          diskMb: requested.disk_mb,
          architecture: requested.architecture ?? "any",
        },
        lifecycle: {
          runtimeTimeoutSeconds: lifecycle.runtime_timeout_seconds,
          idleTimeoutSeconds: lifecycle.idle_timeout_seconds,
          onRuntimeTimeout: lifecycle.on_runtime_timeout ?? "destroy",
          onIdleTimeout: lifecycle.on_idle_timeout ?? "destroy",
        },
        providerOptions: options,
        environment: sandbox.environment,
        secretRefs: sandbox.secretRefs,
        metadata: sandbox.metadata,
      });
      const resolvedResources = remote.resolvedResources ?? resolved;
      const cleanupCreatedResource = async () => {
        try {
          await provider.destroy(remote.providerResourceId);
          return true;
        } catch {
          return false;
        }
      };
      const markCleanupPending = async (message: string) => {
        await withTransaction(db, async (tx) => {
          await tx
            .update(providerAttempts)
            .set({
              state: "reconciling",
              providerResourceId: remote.providerResourceId,
              providerMetadata: remote.providerMetadata ?? {},
              errorCode: "provider_unknown_outcome",
              errorMessage: message,
              outcome: "unknown",
              updatedAt: new Date(),
            })
            .where(eq(providerAttempts.id, attempt!.id));
          await tx
            .update(sandboxes)
            .set({
              status: "cleanup_pending",
              provider: providerName,
              providerCredentialId,
              billingMode: providerCredentialId ? "byok" : "managed",
              providerResourceId: remote.providerResourceId,
              providerOrganizationId: remote.providerOrganizationId,
              providerMetadata: remote.providerMetadata ?? {},
              updatedAt: new Date(),
            })
            .where(eq(sandboxes.id, sandbox.id));
          await tx
            .insert(outboxJobs)
            .values({
              jobType: "sandbox.destroy",
              dedupeKey: `sandbox:destroy:${sandbox.id}`,
              payload: { job_type: "sandbox.destroy", sandbox_id: sandbox.id },
            })
            .onConflictDoNothing();
        });
        await setOperationState(db, operationId, "failed", {
          code: "provider_cleanup_pending",
          message,
          retryable: true,
        });
      };
      let discoveredRuntime: ProviderRuntimeCapabilities | undefined;
      try {
        discoveredRuntime =
          (await provider.discoverRuntimeCapabilities?.(remote.providerResourceId)) ??
          provider.capabilities.runtime;
      } catch (error) {
        if (!(await cleanupCreatedResource())) {
          await markCleanupPending(
            `${providerName} capability discovery failed and cleanup was unconfirmed`,
          );
          return;
        }
        await db
          .update(providerAttempts)
          .set({
            state: "failed",
            providerResourceId: remote.providerResourceId,
            providerMetadata: remote.providerMetadata ?? {},
            errorCode: "capability_discovery_failed",
            errorMessage: safeError(error),
            outcome: "absent",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(providerAttempts.id, attempt!.id));
        await appendOperationEvent(db, operationId, "attempt_failed", {
          attempt_index: attemptIndex,
          provider: providerName,
          code: "capability_discovery_failed",
        });
        continue;
      }
      if (
        !supportsRequestedFeatures(
          discoveredRuntime,
          sandbox.features as Record<string, unknown>,
          provider.capabilities.resume === true,
        )
      ) {
        if (!(await cleanupCreatedResource())) {
          await markCleanupPending(
            `${providerName} lacked requested capabilities and cleanup was unconfirmed`,
          );
          return;
        }
        await db
          .update(providerAttempts)
          .set({
            state: "failed",
            providerResourceId: remote.providerResourceId,
            errorCode: "capability_unsupported",
            errorMessage: `${providerName} did not expose the requested features after provisioning`,
            outcome: "absent",
            completedAt: new Date(),
          })
          .where(eq(providerAttempts.id, attempt!.id));
        continue;
      }
      const capabilitySnapshot = runtimeCapabilities(provider, discoveredRuntime);
      await withTransaction(db, async (tx) => {
        await tx
          .update(providerAttempts)
          .set({
            state: "succeeded",
            providerResourceId: remote.providerResourceId,
            providerMetadata: remote.providerMetadata ?? {},
            resolvedResources,
            outcome: "created",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(providerAttempts.id, attempt!.id));
        const [updated] = await tx
          .update(sandboxes)
          .set({
            provider: providerName,
            providerCredentialId,
            billingMode: providerCredentialId ? "byok" : "managed",
            status: "ready",
            providerResourceId: remote.providerResourceId,
            providerOrganizationId: remote.providerOrganizationId,
            providerMetadata: remote.providerMetadata ?? {},
            providerCapabilities: capabilitySnapshot,
            resolvedResources: {
              vcpu: resolvedResources.vcpu,
              memory_mb: resolvedResources.memoryMb,
              disk_mb: resolvedResources.diskMb,
              architecture: resolvedResources.architecture,
              provider_size: resolvedResources.providerSize,
            },
            readyAt: new Date(),
            updatedAt: new Date(),
            errorCode: null,
          })
          .where(eq(sandboxes.id, sandbox.id))
          .returning();
        if (updated) {
          await recordSandboxEvent(tx, updated, "sandbox.ready", { provider: providerName });
          if (provider.capabilities.cost && provider.name !== "northflank") {
            await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
          }
          await tx
            .insert(outboxJobs)
            .values({
              jobType: "sandbox.destroy",
              dedupeKey: `sandbox:destroy:${updated.id}`,
              payload: { job_type: "sandbox.destroy", sandbox_id: updated.id },
              availableAt: new Date(Date.now() + lifecycle.runtime_timeout_seconds * 1_000),
            })
            .onConflictDoNothing();
        }
      });
      await setOperationState(db, operationId, "succeeded");
      return;
    } catch (error) {
      const classification = classifyProviderFailure(error);
      await db
        .update(providerAttempts)
        .set({
          state: classification.unknown ? "reconciling" : "failed",
          errorCode: classification.kind,
          errorMessage: safeError(error),
          outcome: classification.unknown ? "unknown" : "absent",
          completedAt: classification.unknown ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerAttempts.id, attempt!.id));
      await appendOperationEvent(db, operationId, "attempt_failed", {
        attempt_index: attemptIndex,
        provider: providerName,
        code: classification.kind,
      });
      if (classification.unknown) {
        let reconciliationCompleted = false;
        const reconciled = provider.reconcileCreate
          ? await provider
              .reconcileCreate(sandbox.publicId)
              .then((result) => {
                reconciliationCompleted = true;
                return result;
              })
              .catch(() => null)
          : null;
        if (reconciled) {
          const discoveredRuntime =
            (await provider.discoverRuntimeCapabilities?.(reconciled.providerResourceId)) ??
            provider.capabilities.runtime;
          if (
            !supportsRequestedFeatures(
              discoveredRuntime,
              sandbox.features as Record<string, unknown>,
              provider.capabilities.resume === true,
            )
          ) {
            try {
              await provider.destroy(reconciled.providerResourceId);
            } catch {
              await withTransaction(db, async (tx) => {
                await tx
                  .update(sandboxes)
                  .set({
                    status: "cleanup_pending",
                    provider: providerName,
                    providerCredentialId,
                    billingMode: providerCredentialId ? "byok" : "managed",
                    providerResourceId: reconciled.providerResourceId,
                    providerOrganizationId: reconciled.providerOrganizationId,
                    providerMetadata: reconciled.providerMetadata ?? {},
                    updatedAt: new Date(),
                  })
                  .where(eq(sandboxes.id, sandbox.id));
                await tx
                  .insert(outboxJobs)
                  .values({
                    jobType: "sandbox.destroy",
                    dedupeKey: `sandbox:destroy:${sandbox.id}`,
                    payload: { job_type: "sandbox.destroy", sandbox_id: sandbox.id },
                  })
                  .onConflictDoNothing();
              });
              await setOperationState(db, operationId, "failed", {
                code: "provider_cleanup_pending",
                message: "reconciled resource lacks requested features and cleanup was unconfirmed",
                retryable: true,
              });
              return;
            }
            await db
              .update(providerAttempts)
              .set({
                state: "failed",
                providerResourceId: reconciled.providerResourceId,
                errorCode: "capability_unsupported",
                errorMessage: `${providerName} did not expose the requested features after reconciliation`,
                outcome: "absent",
                completedAt: new Date(),
              })
              .where(eq(providerAttempts.id, attempt!.id));
            continue;
          }
          const capabilitySnapshot = runtimeCapabilities(provider, discoveredRuntime);
          const reconciledResources =
            reconciled.resolvedResources ??
            resolveProviderResources(
              providerName,
              {
                vcpu: requested.vcpu,
                memoryMb: requested.memory_mb,
                diskMb: requested.disk_mb,
                architecture: requested.architecture ?? "any",
              },
              options,
            );
          await withTransaction(db, async (tx) => {
            await tx
              .update(providerAttempts)
              .set({
                state: "succeeded",
                providerResourceId: reconciled.providerResourceId,
                providerMetadata: reconciled.providerMetadata ?? {},
                resolvedResources: reconciledResources,
                outcome: "found",
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(providerAttempts.id, attempt!.id));
            const [updated] = await tx
              .update(sandboxes)
              .set({
                provider: providerName,
                providerCredentialId,
                billingMode: providerCredentialId ? "byok" : "managed",
                status: "ready",
                providerResourceId: reconciled.providerResourceId,
                providerOrganizationId: reconciled.providerOrganizationId,
                providerMetadata: reconciled.providerMetadata ?? {},
                providerCapabilities: capabilitySnapshot,
                resolvedResources: {
                  vcpu: reconciledResources.vcpu,
                  memory_mb: reconciledResources.memoryMb,
                  disk_mb: reconciledResources.diskMb,
                  architecture: reconciledResources.architecture,
                  provider_size: reconciledResources.providerSize,
                },
                readyAt: new Date(),
                updatedAt: new Date(),
                errorCode: null,
                errorMessage: null,
              })
              .where(eq(sandboxes.id, sandbox.id))
              .returning();
            if (updated) {
              await recordSandboxEvent(tx, updated, "sandbox.ready", {
                provider: providerName,
              });
              if (provider.capabilities.cost && provider.name !== "northflank") {
                await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
              }
              await tx
                .insert(outboxJobs)
                .values({
                  jobType: "sandbox.destroy",
                  dedupeKey: `sandbox:destroy:${updated.id}`,
                  payload: { job_type: "sandbox.destroy", sandbox_id: updated.id },
                  availableAt: new Date(Date.now() + lifecycle.runtime_timeout_seconds * 1_000),
                })
                .onConflictDoNothing();
            }
          });
          await setOperationState(db, operationId, "succeeded");
          return;
        }
        if (reconciliationCompleted) {
          continue;
        }
        await db
          .update(sandboxes)
          .set({ status: "provision_unknown", updatedAt: new Date() })
          .where(eq(sandboxes.id, sandbox.id));
        await setOperationState(db, operationId, "reconciling", {
          code: "provider_unknown_outcome",
          message: safeError(error),
          retryable: true,
        });
        throw new ProviderError(
          "provider create reconciliation did not complete",
          "unknown_outcome",
          true,
        );
      }
      if (!classification.fallbackSafe) {
        break;
      }
    }
  }
  await db
    .update(sandboxes)
    .set({ status: "failed", errorCode: "no_eligible_provider", updatedAt: new Date() })
    .where(eq(sandboxes.id, sandbox.id));
  await setOperationState(db, operationId, "failed", {
    code: "no_eligible_provider",
    message: "all selected providers failed or were ineligible",
    retryable: false,
  });
}

const lostProviderSandboxStates = new Set<ProviderSandboxState>(["stopped", "failed", "absent"]);

function providerSandboxLossSuspected(failure: unknown): boolean {
  if (failure instanceof OutboxLeaseLostError) return false;
  return (
    !(failure instanceof ProviderError) ||
    failure.kind === "unavailable" ||
    failure.kind === "unknown_outcome"
  );
}

function providerStoppedMessage(
  provider: SandboxProviderName,
  inspection: ProviderSandboxInspection,
): string {
  const observed =
    inspection.state === "absent"
      ? `${provider} no longer has this sandbox`
      : `${provider} reported the sandbox as ${inspection.providerState ?? inspection.state}`;
  return redactString(
    `${observed}${inspection.reason ? `: ${inspection.reason}` : ""}`.slice(0, 500),
  );
}

async function reconcileProviderSandboxState(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  failure?: unknown,
) {
  if (!provider.inspect) return;
  if (failure !== undefined && !providerSandboxLossSuspected(failure)) return;
  const sandbox = await db
    .select({ status: sandboxes.status, providerResourceId: sandboxes.providerResourceId })
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  const providerResourceId = sandbox?.providerResourceId;
  if (sandbox?.status !== "ready" || !providerResourceId) return;
  const inspection = await provider.inspect(providerResourceId).catch(() => null);
  if (!inspection || !lostProviderSandboxStates.has(inspection.state)) return;
  await withTransaction(db, async (tx) => {
    const now = new Date();
    const [stopping] = await tx
      .update(sandboxes)
      .set({
        status: "stopping",
        errorCode: "provider_stopped",
        errorMessage: providerStoppedMessage(provider.name, inspection),
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, sandboxId),
          eq(sandboxes.status, "ready"),
          eq(sandboxes.providerResourceId, providerResourceId),
        ),
      )
      .returning({ id: sandboxes.id });
    if (!stopping) return;
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "sandbox.destroy",
        dedupeKey: `sandbox:destroy:${sandboxId}`,
        payload: { job_type: "sandbox.destroy", sandbox_id: sandboxId },
        availableAt: now,
      })
      .onConflictDoUpdate({
        target: outboxJobs.dedupeKey,
        set: {
          status: "pending",
          attemptCount: 0,
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastError: null,
          completedAt: null,
          updatedAt: now,
        },
        setWhere: ne(outboxJobs.status, "leased"),
      });
  });
}

async function destroySandbox(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  operationId?: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "stopped" || sandbox.status === "deleted") {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  const providerStopped = sandbox.errorCode === "provider_stopped";
  const destroyResult = sandbox.providerResourceId
    ? await provider.destroy(sandbox.providerResourceId)
    : undefined;
  await withTransaction(db, async (tx) => {
    const stoppedAt = new Date();
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "stopped",
        errorCode: providerStopped ? sandbox.errorCode : null,
        errorMessage: providerStopped ? sandbox.errorMessage : null,
        providerMetadata: {
          ...sandbox.providerMetadata,
          ...(destroyResult?.providerMetadata ?? {}),
        },
        deletedAt: stoppedAt,
        updatedAt: stoppedAt,
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    await tx
      .update(sandboxRecordings)
      .set({
        state: "failed",
        error: {
          code: "sandbox_stopped",
          message: "sandbox stopped before the recording completed",
          retryable: false,
        },
        operationToken: null,
        stoppedAt,
        updatedAt: stoppedAt,
      })
      .where(
        and(
          eq(sandboxRecordings.sandboxId, sandbox.id),
          inArray(sandboxRecordings.state, ["starting", "recording", "stopping"]),
        ),
      );
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.deleted", {
        provider: provider.name,
        ...(providerStopped ? { reason: "provider_stopped" } : {}),
      });
      if (provider.capabilities.cost) {
        const availableAt =
          provider.name === "codesandbox" ||
          provider.name === "e2b" ||
          provider.name === "freestyle" ||
          provider.name === "runloop" ||
          provider.name === "vercel"
            ? new Date(Date.now() + 2_000)
            : provider.name === "cloudflare"
              ? new Date(Date.now() + 10 * 60_000)
              : provider.name === "blaxel"
                ? new Date(Date.now() + 5 * 60_000)
                : provider.name === "northflank"
                  ? northflankBillingAvailableAt(updated.deletedAt ?? new Date())
                  : new Date(Date.now() + 120_000);
        await scheduleCostSync(tx, updated.id, availableAt, true);
      }
    }
  });
  await setOperationState(db, operationId, "succeeded");
}

async function pauseSandbox(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  operationId: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "paused" || sandbox.status === "stopped") {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  if (!sandbox.providerResourceId) {
    throw new Error("sandbox has no provider resource");
  }
  const activeRecording = await db
    .select({ id: sandboxRecordings.id })
    .from(sandboxRecordings)
    .where(
      and(
        eq(sandboxRecordings.sandboxId, sandbox.id),
        inArray(sandboxRecordings.state, ["starting", "recording", "stopping"]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (activeRecording) {
    throw new ProviderError(
      "stop active computer recordings before pausing the sandbox",
      "customer",
      false,
    );
  }
  await provider.pause(sandbox.providerResourceId);
  await withTransaction(db, async (tx) => {
    const pausedAt = new Date();
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "paused",
        errorCode: null,
        errorMessage: null,
        pausedAt,
        updatedAt: pausedAt,
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.paused", {
        provider: provider.name,
      });
      if (provider.capabilities.cost) {
        const final = provider.name === "codesandbox" || provider.name === "northflank";
        await scheduleCostSync(
          tx,
          updated.id,
          provider.name === "northflank"
            ? northflankBillingAvailableAt(updated.pausedAt ?? new Date())
            : new Date(Date.now() + 5_000),
          final,
        );
      }
    }
  });
  await setOperationState(db, operationId, "succeeded");
}

async function resumeSandbox(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  operationId: string,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "ready") {
    await setOperationState(db, operationId, "succeeded");
    return;
  }
  if (!sandbox.providerResourceId || !provider.resume) {
    throw new ProviderError("provider does not support resume", "unsupported", false);
  }
  const remote = await provider.resume(sandbox.providerResourceId);
  let providerMetadata = remote?.providerMetadata ?? sandbox.providerMetadata;
  if (provider.name === "codesandbox" && provider.capabilities.cost) {
    // CodeSandbox restarts its cost timer on resume (startedAt = now). Carry the
    // cost accrued through the pause forward as a cumulative baseline and keep
    // the prior rate-card fields, otherwise the next cost sync sees a collapsed
    // amount and posts a negative delta that credits back every prior usage
    // charge. The baseline is recomputed from the pre-resume metadata rather
    // than copied from providerCostMicrousd, which can lag the true accrued
    // amount while the pause-time final cost sync is still pending.
    const merged: Record<string, unknown> = {
      ...(sandbox.providerMetadata ?? {}),
      ...(remote?.providerMetadata ?? {}),
    };
    let baselineMicrousd = sandbox.providerCostMicrousd ?? 0n;
    const accrued = await provider
      .getCost({
        providerResourceId: sandbox.providerResourceId,
        providerOrganizationId: sandbox.providerOrganizationId ?? undefined,
        providerMetadata: sandbox.providerMetadata,
        from: sandbox.readyAt ?? sandbox.createdAt,
        to: sandbox.pausedAt ?? new Date(),
      })
      .catch(() => null);
    if (accrued && accrued.amountMicrousd > baselineMicrousd) {
      baselineMicrousd = accrued.amountMicrousd;
    }
    if (baselineMicrousd > 0n) {
      merged.costBaselineMicrousd = baselineMicrousd.toString();
    }
    providerMetadata = merged;
  }
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status: "ready",
        providerResourceId: remote?.providerResourceId ?? sandbox.providerResourceId,
        providerOrganizationId: remote?.providerOrganizationId ?? sandbox.providerOrganizationId,
        providerMetadata,
        pausedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.resumed", {
        provider: provider.name,
      });
      if (provider.capabilities.cost && provider.name !== "northflank") {
        await scheduleCostSync(tx, updated.id, new Date(Date.now() + 5_000), false);
      }
    }
  });
  await setOperationState(db, operationId, "succeeded");
}

async function syncSandboxCost(
  db: MetalDb,
  provider: SandboxProvider,
  sandboxId: string,
  final: boolean,
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (!sandbox?.providerResourceId) {
    return;
  }
  const measuredAt = new Date();
  const cost = await provider.getCost({
    providerResourceId: sandbox.providerResourceId,
    providerOrganizationId: sandbox.providerOrganizationId ?? undefined,
    providerMetadata: sandbox.providerMetadata,
    from: sandbox.readyAt ?? sandbox.createdAt,
    to:
      provider.name === "codesandbox" && sandbox.pausedAt
        ? sandbox.pausedAt
        : (sandbox.deletedAt ?? sandbox.pausedAt ?? measuredAt),
  });
  if (!cost && final && sandbox.billingMode === "managed") {
    throw new Error("final provider cost is not available yet");
  }
  await withTransaction(db, async (tx) => {
    if (cost) {
      await tx
        .insert(providerCostSnapshots)
        .values({
          sandboxId: sandbox.id,
          organizationId: sandbox.organizationId,
          projectId: sandbox.projectId,
          provider: provider.name,
          providerResourceId: sandbox.providerResourceId!,
          billingMode: sandbox.billingMode,
          amountMicrousd: cost.amountMicrousd,
          costDeltaMicrousd: cost.amountMicrousd - (sandbox.providerCostMicrousd ?? 0n),
          measuredFrom: sandbox.providerCostMeasuredThrough,
          measuredThrough: cost.measuredThrough,
          costProvenance: cost.provenance,
          costConfidence: cost.confidence,
          costSource: cost.source,
          rateCardVersion: cost.rateCardVersion,
          rawPayload: cost.raw,
        })
        .onConflictDoNothing();
      const snapshot = await tx
        .select()
        .from(providerCostSnapshots)
        .where(
          and(
            eq(providerCostSnapshots.sandboxId, sandbox.id),
            eq(providerCostSnapshots.amountMicrousd, cost.amountMicrousd),
            eq(providerCostSnapshots.measuredThrough, cost.measuredThrough),
          ),
        )
        .then((rows) => rows[0]);
      const [updated] = await tx
        .update(sandboxes)
        .set({
          providerCostMicrousd: cost.amountMicrousd,
          providerOrganizationId: cost.providerOrganizationId,
          providerCostMeasuredThrough: cost.measuredThrough,
          providerCostUpdatedAt: measuredAt,
          updatedAt: measuredAt,
        })
        .where(eq(sandboxes.id, sandbox.id))
        .returning();
      if (updated) {
        await recordSandboxEvent(tx, updated, "sandbox.cost_updated", {
          provider: provider.name,
          cost_microusd: cost.amountMicrousd.toString(),
          cost_updated_at: measuredAt.toISOString(),
        });
      }
      if (snapshot && sandbox.billingMode === "managed") {
        await chargeUsageDelta(tx, {
          organizationId: sandbox.organizationId,
          projectId: sandbox.projectId,
          sandboxId: sandbox.id,
          snapshotId: snapshot.id,
          currentCostMicrousd: cost.amountMicrousd,
          measuredFrom: sandbox.providerCostMeasuredThrough,
          measuredThrough: cost.measuredThrough,
          actorId: sandbox.createdBy,
        });
      }
    }
    if (!final && sandbox.status !== "stopped" && sandbox.status !== "deleted") {
      const delayMs = sandbox.status === "paused" ? 5 * 60_000 : 60_000;
      await scheduleCostSync(tx, sandbox.id, new Date(Date.now() + delayMs), false);
    }
  });
  if (!final && sandbox.status === "ready") {
    await reconcileProviderSandboxState(db, provider, sandbox.id);
  }
}

const terminalProcessStates = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const terminalRuntimeOperationStates = new Set(["succeeded", "failed", "cancelled"]);

function supportsRequestedFeatures(
  runtime: ProviderRuntimeCapabilities | undefined,
  features: Record<string, unknown>,
  resume: boolean,
): boolean {
  if (features.pause_resume === true && !resume) return false;
  if (features.computer_use === true) {
    if (!runtime?.computer?.screenshot || runtime.computer.actions.length === 0) return false;
  }
  const recording = features.recording as { format?: string } | undefined;
  if (
    recording &&
    (!runtime?.computer?.recording ||
      !runtime.computer.recording.formats.includes((recording.format ?? "mp4") as "mp4" | "webm"))
  ) {
    return false;
  }
  return true;
}

function runtimeCapabilities(
  provider: SandboxProvider,
  runtime: ProviderRuntimeCapabilities | undefined = provider.capabilities.runtime,
): Record<string, unknown> {
  return {
    provider: provider.name,
    version: "1",
    lifecycle: {
      pause: provider.capabilities.pause,
      resume: provider.capabilities.resume === true,
    },
    ...(runtime?.process
      ? {
          process: {
            execute: runtime.process.exec,
            cancel: runtime.process.cancel,
            ordered_output: runtime.process.streams,
            max_output_bytes: runtime.process.maxOutputBytes,
          },
        }
      : {}),
    ...(runtime?.files
      ? {
          filesystem: {
            read: runtime.files.read,
            write: runtime.files.write,
            write_modes: [...runtime.files.writeModes],
            create_parents: runtime.files.createParents,
            list: runtime.files.list,
            delete: runtime.files.delete,
            max_read_bytes: runtime.files.maxReadBytes,
            max_write_bytes: runtime.files.maxWriteBytes,
          },
        }
      : {}),
    ...(runtime?.httpEndpoints
      ? {
          http_endpoints: {
            create: runtime.httpEndpoints.expose,
            revoke: runtime.httpEndpoints.revoke,
            ...(runtime.httpEndpoints.maxLeaseDurationSeconds
              ? { max_lease_seconds: runtime.httpEndpoints.maxLeaseDurationSeconds }
              : {}),
          },
        }
      : {}),
    ...(runtime?.computer
      ? {
          computer: {
            implementation: runtime.computer.implementation,
            actions: [...runtime.computer.actions],
            ...(runtime.computer.screenshot
              ? {
                  screenshot: {
                    formats: [...runtime.computer.screenshot.formats],
                    max_bytes: runtime.computer.screenshot.maxBytes,
                  },
                }
              : {}),
            ...(runtime.computer.recording
              ? {
                  recording: {
                    formats: [...runtime.computer.recording.formats],
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function sandboxNotReady(sandbox: typeof sandboxes.$inferSelect): ProviderError {
  const reason = sandbox.errorCode ? `: ${sandbox.errorCode}` : "";
  return new ProviderError(`sandbox is not ready (${sandbox.status}${reason})`, "customer", false);
}

function runtimeError(error: unknown, fallbackCode = "runtime_operation_failed") {
  const classification = classifyProviderFailure(error);
  return {
    code: classification.kind === "unsupported" ? "capability_unsupported" : fallbackCode,
    message: error instanceof ProviderError ? safeError(error) : "runtime operation failed",
    retryable: classification.retryable,
  };
}

async function appendProcessEvent(
  db: MetalDb,
  processId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  await db.execute(sql`
    with locked as (
      select id from metal.sandbox_processes where id = ${processId} for update
    )
    insert into metal.process_events (process_id, sequence, type, data)
    select ${processId}, coalesce(max(events.sequence), 0) + 1, ${type}, ${JSON.stringify(data)}::jsonb
    from locked
    left join metal.process_events events on events.process_id = locked.id
    group by locked.id
  `);
}

async function finishProcess(
  db: MetalDb,
  processId: string,
  guard: JobLeaseGuard,
  input: {
    state: "succeeded" | "failed" | "cancelled" | "timed_out";
    exitCode?: number | null;
    terminationSignal?: string | null;
    outputTruncated?: boolean;
    error?: Record<string, unknown> | null;
    eventType: "exited" | "failed" | "cancelled" | "timed_out";
    eventData: Record<string, unknown>;
  },
) {
  await guard.assertOwned();
  await withTransaction(db, async (tx) => {
    const current = await tx
      .select({
        sandbox: sandboxes,
      })
      .from(sandboxProcesses)
      .innerJoin(sandboxes, eq(sandboxes.id, sandboxProcesses.sandboxId))
      .where(eq(sandboxProcesses.id, processId))
      .then((rows) => rows[0]);
    if (!current) return;
    const now = new Date();
    const [updated] = await tx
      .update(sandboxProcesses)
      .set({
        state: input.state,
        exitCode: input.exitCode,
        terminationSignal: input.terminationSignal,
        ...(input.outputTruncated !== undefined ? { outputTruncated: input.outputTruncated } : {}),
        error: input.error,
        completedAt: now,
      })
      .where(
        and(
          eq(sandboxProcesses.id, processId),
          eq(sandboxProcesses.operationToken, guard.token),
          inArray(sandboxProcesses.state, ["queued", "running", "cancelling"]),
        ),
      )
      .returning({ publicId: sandboxProcesses.publicId });
    if (!updated) return;
    await appendProcessEvent(tx, processId, input.eventType, input.eventData);
    await recordSandboxEvent(
      tx,
      current.sandbox,
      input.state === "succeeded"
        ? "process.completed"
        : input.state === "cancelled"
          ? "process.cancelled"
          : "process.failed",
      {
        process_id: updated.publicId,
        state: input.state,
        ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
      },
    );
  });
}

async function failProcess(
  db: MetalDb,
  processId: string,
  guard: JobLeaseGuard,
  error: unknown,
  timeoutSeconds: number,
) {
  const providerError = error instanceof ProviderError ? error : undefined;
  if (providerError?.kind === "timeout_absent") {
    await finishProcess(db, processId, guard, {
      state: "timed_out",
      terminationSignal: null,
      eventType: "timed_out",
      eventData: { timeout_seconds: timeoutSeconds, termination_signal: null },
    });
    return;
  }
  const safe = runtimeError(error, "process_failed");
  await finishProcess(db, processId, guard, {
    state: "failed",
    error: safe,
    eventType: "failed",
    eventData: safe,
  });
}

function processOutputChunks(event: Extract<ProviderExecEvent, { type: "stdout" | "stderr" }>) {
  const chunks: Uint8Array[] = [];
  const maxChunkBytes = 256 * 1_024;
  for (let offset = 0; offset < event.data.byteLength; offset += maxChunkBytes) {
    chunks.push(event.data.slice(offset, offset + maxChunkBytes));
  }
  if (event.data.byteLength === 0) chunks.push(event.data);
  return chunks;
}

async function executeProcess(
  db: MetalDb,
  provider: SandboxProvider,
  processId: string,
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  let row = await db
    .select({ process: sandboxProcesses, sandbox: sandboxes })
    .from(sandboxProcesses)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxProcesses.sandboxId))
    .where(eq(sandboxProcesses.id, processId))
    .then((rows) => rows[0]);
  if (!row || terminalProcessStates.has(row.process.state)) return;

  if (row.process.state !== "queued") {
    const [claimed] = await db
      .update(sandboxProcesses)
      .set({ operationToken: guard.token })
      .where(
        and(
          eq(sandboxProcesses.id, processId),
          inArray(sandboxProcesses.state, ["running", "cancelling"]),
          sql`${sandboxProcesses.operationToken} is not distinct from ${row.process.operationToken}::uuid`,
        ),
      )
      .returning();
    if (!claimed) return;
    if (claimed.state === "cancelling" && !claimed.startedAt && !claimed.providerExecutionId) {
      await finishProcess(db, processId, guard, {
        state: "cancelled",
        terminationSignal: null,
        eventType: "cancelled",
        eventData: { termination_signal: null },
      });
      return;
    }
    if (claimed.providerExecutionId) {
      const canCancel =
        row.sandbox.providerResourceId &&
        provider.capabilities.runtime?.process?.cancel &&
        provider.cancelExec;
      if (canCancel) {
        await guard.assertOwned();
        const result = await provider.cancelExec!({
          providerResourceId: row.sandbox.providerResourceId!,
          executionId: claimed.providerExecutionId,
        });
        if (result.executionId !== claimed.providerExecutionId || !result.cancelled) {
          throw new ProviderError(
            "reclaimed process execution could not be remotely reconciled",
            "unknown_outcome",
            true,
          );
        }
        if (claimed.state === "cancelling") {
          await finishProcess(db, processId, guard, {
            state: "cancelled",
            terminationSignal: null,
            eventType: "cancelled",
            eventData: { termination_signal: null },
          });
          return;
        }
      }
    }
    await failProcess(
      db,
      processId,
      guard,
      new ProviderError(
        claimed.providerExecutionId
          ? "process execution was reclaimed; remote termination must be reconciled"
          : "process execution identity was not persisted before worker ownership changed",
        "unknown_outcome",
        false,
      ),
      claimed.timeoutSeconds,
    );
    return;
  }

  const capabilities = provider.capabilities.runtime?.process;
  const snapshot = runtimeCapabilities(provider);
  const startedAt = new Date();
  const [claimed] = await db
    .update(sandboxProcesses)
    .set({
      state: "running",
      providerCapabilities: snapshot,
      operationToken: guard.token,
    })
    .where(and(eq(sandboxProcesses.id, processId), eq(sandboxProcesses.state, "queued")))
    .returning();
  if (!claimed) return;
  row = { ...row, process: claimed };

  if (row.sandbox.status !== "ready" || !row.sandbox.providerResourceId) {
    await failProcess(
      db,
      processId,
      guard,
      sandboxNotReady(row.sandbox),
      row.process.timeoutSeconds,
    );
    return;
  }
  if (!capabilities?.exec || !provider.exec) {
    await failProcess(
      db,
      processId,
      guard,
      new ProviderError("provider does not support process execution", "unsupported", false),
      row.process.timeoutSeconds,
    );
    return;
  }
  if (row.process.maxOutputBytes > capabilities.maxOutputBytes) {
    await failProcess(
      db,
      processId,
      guard,
      new ProviderError("requested process output exceeds provider limit", "unsupported", false),
      row.process.timeoutSeconds,
    );
    return;
  }
  const started = await withTransaction(db, async (tx) => {
    const [owned] = await tx
      .update(sandboxProcesses)
      .set({ startedAt })
      .where(
        and(
          eq(sandboxProcesses.id, processId),
          eq(sandboxProcesses.state, "running"),
          eq(sandboxProcesses.operationToken, guard.token),
        ),
      )
      .returning({ id: sandboxProcesses.id });
    if (!owned) return false;
    await appendProcessEvent(tx, processId, "started");
    await recordSandboxEvent(tx, row.sandbox, "process.started", {
      process_id: row.process.publicId,
    });
    return true;
  });
  if (!started) return;
  const controller = new AbortController();
  const deadline = new Date(startedAt.getTime() + row.process.timeoutSeconds * 1_000);
  const timer = setTimeout(() => controller.abort(), row.process.timeoutSeconds * 1_000);
  let outputBytes = row.process.outputBytes;
  let outputTruncated = row.process.outputTruncated;
  const offsets = { stdout: 0, stderr: 0 };
  let lastProviderSequence = -1;
  let executionId: string | undefined;
  let receivedExitEvent = false;
  try {
    await guard.assertOwned();
    const execution = await provider.exec({
      providerResourceId: row.sandbox.providerResourceId,
      command: row.process.command,
      cwd: row.process.cwd ?? undefined,
      environment: row.process.environment,
      maxOutputBytes: row.process.maxOutputBytes,
      deadline,
      signal: controller.signal,
    });
    if (!execution.executionId) {
      throw new ProviderError("provider returned an empty execution id", "unknown_outcome", false);
    }
    executionId = execution.executionId;
    const [identified] = await db
      .update(sandboxProcesses)
      .set({
        providerExecutionId: execution.executionId,
      })
      .where(
        and(
          eq(sandboxProcesses.id, processId),
          inArray(sandboxProcesses.state, ["running", "cancelling"]),
          sql`${sandboxProcesses.providerExecutionId} is null`,
        ),
      )
      .returning({ operationToken: sandboxProcesses.operationToken });
    if (!identified) {
      throw new ProviderError(
        "provider execution identity conflicted with persisted state",
        "unknown_outcome",
        false,
      );
    }
    await guard.assertOwned();
    if (identified.operationToken !== guard.token) return;

    for await (const event of execution.events) {
      await guard.assertOwned();
      const current = await db
        .select({
          state: sandboxProcesses.state,
          operationToken: sandboxProcesses.operationToken,
        })
        .from(sandboxProcesses)
        .where(eq(sandboxProcesses.id, processId))
        .then((rows) => rows[0]);
      if (
        !current ||
        current.operationToken !== guard.token ||
        terminalProcessStates.has(current.state)
      )
        return;
      if (event.sequence <= lastProviderSequence) {
        throw new ProviderError(
          "provider returned out-of-order process events",
          "unknown_outcome",
          false,
        );
      }
      lastProviderSequence = event.sequence;
      if (event.type === "stdout" || event.type === "stderr") {
        if (event.truncated) outputTruncated = true;
        for (const chunk of processOutputChunks(event)) {
          const remaining = Math.max(0, row.process.maxOutputBytes - outputBytes);
          const bounded = chunk.slice(0, remaining);
          if (bounded.byteLength < chunk.byteLength) outputTruncated = true;
          if (bounded.byteLength === 0 && chunk.byteLength > 0) {
            await db
              .update(sandboxProcesses)
              .set({ outputTruncated: true })
              .where(
                and(
                  eq(sandboxProcesses.id, processId),
                  eq(sandboxProcesses.operationToken, guard.token),
                  inArray(sandboxProcesses.state, ["running", "cancelling"]),
                ),
              );
            continue;
          }
          const streamOffset = offsets[event.type];
          const persisted = await withTransaction(db, async (tx) => {
            const [updated] = await tx
              .update(sandboxProcesses)
              .set({
                outputBytes: outputBytes + bounded.byteLength,
                outputTruncated,
              })
              .where(
                and(
                  eq(sandboxProcesses.id, processId),
                  eq(sandboxProcesses.operationToken, guard.token),
                  inArray(sandboxProcesses.state, ["running", "cancelling"]),
                ),
              )
              .returning({ id: sandboxProcesses.id });
            if (!updated) return false;
            await appendProcessEvent(tx, processId, event.type, {
              data_base64: Buffer.from(bounded).toString("base64"),
              byte_length: bounded.byteLength,
              stream_offset_bytes: streamOffset,
            });
            return true;
          });
          if (!persisted) return;
          outputBytes += bounded.byteLength;
          offsets[event.type] += bounded.byteLength;
        }
        continue;
      }
      if (event.type !== "exit") continue;
      receivedExitEvent = true;
      outputTruncated ||= event.outputTruncated;
      if (event.cancelled) {
        await finishProcess(db, processId, guard, {
          state: "cancelled",
          terminationSignal: event.signal,
          outputTruncated,
          eventType: "cancelled",
          eventData: { termination_signal: event.signal },
        });
      } else if (event.exitCode === null) {
        await failProcess(
          db,
          processId,
          guard,
          new Error("provider process exited without an exit code"),
          row.process.timeoutSeconds,
        );
      } else if (event.exitCode === 0) {
        await finishProcess(db, processId, guard, {
          state: "succeeded",
          exitCode: event.exitCode,
          terminationSignal: event.signal,
          outputTruncated,
          eventType: "exited",
          eventData: { exit_code: event.exitCode },
        });
      } else {
        await finishProcess(db, processId, guard, {
          state: "failed",
          exitCode: event.exitCode,
          terminationSignal: event.signal,
          outputTruncated,
          error: {
            code: "process_exit_nonzero",
            message: `process exited with code ${event.exitCode}`,
            retryable: false,
          },
          eventType: "exited",
          eventData: { exit_code: event.exitCode },
        });
      }
    }
    if (!receivedExitEvent) {
      throw new ProviderError(
        "provider process stream ended without an exit event",
        "unknown_outcome",
        false,
      );
    }
  } catch (error) {
    if (controller.signal.aborted || new Date() >= deadline) {
      const canCancel =
        executionId &&
        row.sandbox.providerResourceId &&
        provider.capabilities.runtime?.process?.cancel &&
        provider.cancelExec;
      const cancellation = canCancel
        ? await provider.cancelExec!({
            providerResourceId: row.sandbox.providerResourceId,
            executionId: executionId!,
          }).catch(() => null)
        : null;
      if (cancellation?.cancelled) {
        await finishProcess(db, processId, guard, {
          state: "timed_out",
          terminationSignal: null,
          outputTruncated,
          eventType: "timed_out",
          eventData: {
            timeout_seconds: row.process.timeoutSeconds,
            termination_signal: null,
          },
        });
      } else {
        await failProcess(
          db,
          processId,
          guard,
          new ProviderError(
            "process timed out but remote termination could not be confirmed",
            "unknown_outcome",
            false,
          ),
          row.process.timeoutSeconds,
        );
        await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
      }
    } else {
      await failProcess(db, processId, guard, error, row.process.timeoutSeconds);
      await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function cancelProcessExecution(
  db: MetalDb,
  provider: SandboxProvider,
  processId: string,
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  const row = await db
    .select({ process: sandboxProcesses, sandbox: sandboxes })
    .from(sandboxProcesses)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxProcesses.sandboxId))
    .where(eq(sandboxProcesses.id, processId))
    .then((rows) => rows[0]);
  if (!row || terminalProcessStates.has(row.process.state)) return;
  const [claimed] = await db
    .update(sandboxProcesses)
    .set({ operationToken: guard.token })
    .where(
      and(
        eq(sandboxProcesses.id, processId),
        inArray(sandboxProcesses.state, ["queued", "running", "cancelling"]),
        sql`${sandboxProcesses.operationToken} is not distinct from ${row.process.operationToken}::uuid`,
      ),
    )
    .returning();
  if (!claimed) return;
  const executionId = claimed.providerExecutionId ?? undefined;
  if (!executionId) {
    if (!claimed.startedAt) {
      await finishProcess(db, processId, guard, {
        state: "cancelled",
        terminationSignal: null,
        eventType: "cancelled",
        eventData: { termination_signal: null },
      });
      return;
    }
    throw new ProviderError(
      "process cancellation is waiting for a durable provider execution id",
      "unknown_outcome",
      true,
    );
  }
  if (claimed.state !== "cancelling") {
    return;
  }
  if (
    !row.sandbox.providerResourceId ||
    !provider.capabilities.runtime?.process?.cancel ||
    !provider.cancelExec
  ) {
    await failProcess(
      db,
      processId,
      guard,
      new ProviderError("provider does not support process cancellation", "unsupported", false),
      row.process.timeoutSeconds,
    );
    return;
  }
  await guard.assertOwned();
  const result = await provider
    .cancelExec({
      providerResourceId: row.sandbox.providerResourceId,
      executionId,
    })
    .catch(async (error: unknown) => {
      await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
      throw error;
    });
  if (result.executionId !== executionId || !result.cancelled) {
    throw new ProviderError(
      "provider did not confirm process cancellation",
      "unknown_outcome",
      true,
    );
  }
  await finishProcess(db, processId, guard, {
    state: "cancelled",
    terminationSignal: null,
    eventType: "cancelled",
    eventData: { termination_signal: null },
  });
}

async function executeFilesystemOperation(
  db: MetalDb,
  provider: SandboxProvider,
  operationId: string,
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  const row = await db
    .select({ operation: runtimeOperations, sandbox: sandboxes })
    .from(runtimeOperations)
    .innerJoin(sandboxes, eq(sandboxes.id, runtimeOperations.sandboxId))
    .where(eq(runtimeOperations.id, operationId))
    .then((rows) => rows[0]);
  if (!row || terminalRuntimeOperationStates.has(row.operation.state)) return;
  const snapshot = runtimeCapabilities(provider);
  const capabilities = provider.capabilities.runtime?.files;
  const request = row.operation.request;
  const now = new Date();
  const [claimed] = await db
    .update(runtimeOperations)
    .set({
      state: "running",
      startedAt: row.operation.startedAt ?? now,
      providerCapabilities: snapshot,
      operationToken: guard.token,
    })
    .where(
      row.operation.state === "queued"
        ? and(eq(runtimeOperations.id, operationId), eq(runtimeOperations.state, "queued"))
        : and(
            eq(runtimeOperations.id, operationId),
            eq(runtimeOperations.state, "running"),
            sql`${runtimeOperations.operationToken} is not distinct from ${row.operation.operationToken}::uuid`,
          ),
    )
    .returning();
  if (!claimed) return;
  try {
    if (row.operation.state !== "queued") {
      throw new ProviderError(
        "filesystem operation was reclaimed without provider reconciliation support",
        "unknown_outcome",
        false,
      );
    }
    if (row.sandbox.status !== "ready" || !row.sandbox.providerResourceId) {
      throw sandboxNotReady(row.sandbox);
    }
    let result: Record<string, unknown>;
    if (row.operation.kind === "filesystem_read") {
      if (!capabilities?.read || !provider.readFile)
        throw new ProviderError("filesystem read is unsupported", "unsupported", false);
      const limit = Number(request.limit_bytes);
      if (limit > capabilities.maxReadBytes)
        throw new ProviderError("filesystem read exceeds provider limit", "unsupported", false);
      await guard.assertOwned();
      const value = await provider.readFile({
        providerResourceId: row.sandbox.providerResourceId,
        path: String(request.path),
        encoding: "binary",
        offsetBytes: Number(request.offset_bytes),
        maxBytes: limit,
      });
      const data =
        typeof value.data === "string" ? Buffer.from(value.data) : Buffer.from(value.data);
      result = {
        kind: row.operation.kind,
        path: value.path,
        data_base64: data.toString("base64"),
        offset_bytes: value.offsetBytes,
        byte_length: value.byteLength,
        eof: value.eof,
      };
    } else if (row.operation.kind === "filesystem_write") {
      if (!capabilities?.write || !provider.writeFile)
        throw new ProviderError("filesystem write is unsupported", "unsupported", false);
      const data = Buffer.from(String(request.data_base64), "base64");
      if (data.byteLength > capabilities.maxWriteBytes)
        throw new ProviderError("filesystem write exceeds provider limit", "unsupported", false);
      const mode = request.mode as "create" | "overwrite" | "append";
      if (!capabilities.writeModes.includes(mode))
        throw new ProviderError(
          `filesystem write mode ${mode} is unsupported`,
          "unsupported",
          false,
        );
      if (request.create_parents === true && !capabilities.createParents)
        throw new ProviderError("filesystem parent creation is unsupported", "unsupported", false);
      await guard.assertOwned();
      const value = await provider.writeFile({
        providerResourceId: row.sandbox.providerResourceId,
        path: String(request.path),
        data,
        mode,
        createParents: Boolean(request.create_parents),
      });
      result = { kind: row.operation.kind, path: value.path, bytes_written: value.bytesWritten };
    } else if (row.operation.kind === "filesystem_list") {
      if (!capabilities?.list || !provider.listFiles)
        throw new ProviderError("filesystem list is unsupported", "unsupported", false);
      const maxEntries = Number(request.max_entries);
      if (maxEntries > capabilities.maxListEntries)
        throw new ProviderError("filesystem list exceeds provider limit", "unsupported", false);
      await guard.assertOwned();
      const value = await provider.listFiles({
        providerResourceId: row.sandbox.providerResourceId,
        path: String(request.path),
        recursive: Boolean(request.recursive),
        maxEntries,
      });
      result = {
        kind: row.operation.kind,
        path: String(request.path),
        entries: value.entries.map((entry) => ({
          path: entry.path,
          type: entry.type,
          size_bytes: entry.sizeBytes,
          modified_at: entry.modifiedAt?.toISOString() ?? null,
        })),
        truncated: value.truncated,
      };
    } else {
      if (!capabilities?.delete || !provider.deleteFile)
        throw new ProviderError("filesystem delete is unsupported", "unsupported", false);
      await guard.assertOwned();
      const value = await provider.deleteFile({
        providerResourceId: row.sandbox.providerResourceId,
        path: String(request.path),
        recursive: Boolean(request.recursive),
      });
      result = { kind: row.operation.kind, path: value.path, deleted: value.deleted };
    }
    await guard.assertOwned();
    await withTransaction(db, async (tx) => {
      const [updated] = await tx
        .update(runtimeOperations)
        .set({ state: "succeeded", result, error: null, completedAt: new Date() })
        .where(
          and(
            eq(runtimeOperations.id, operationId),
            eq(runtimeOperations.state, "running"),
            eq(runtimeOperations.operationToken, guard.token),
          ),
        )
        .returning({ id: runtimeOperations.id });
      if (!updated) return;
      await recordSandboxEvent(tx, row.sandbox, "runtime_operation.completed", {
        runtime_operation_id: row.operation.publicId,
        kind: row.operation.kind,
      });
    });
  } catch (error) {
    if (error instanceof OutboxLeaseLostError) throw error;
    await withTransaction(db, async (tx) => {
      const safe = runtimeError(error);
      const [updated] = await tx
        .update(runtimeOperations)
        .set({ state: "failed", error: safe, completedAt: new Date() })
        .where(
          and(
            eq(runtimeOperations.id, operationId),
            eq(runtimeOperations.state, "running"),
            eq(runtimeOperations.operationToken, guard.token),
          ),
        )
        .returning({ id: runtimeOperations.id });
      if (!updated) return;
      await recordSandboxEvent(tx, row.sandbox, "runtime_operation.failed", {
        runtime_operation_id: row.operation.publicId,
        kind: row.operation.kind,
        code: safe.code,
      });
    });
    await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
  }
}

async function executeComputerOperation(
  db: MetalDb,
  provider: SandboxProvider,
  operationId: string,
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  const row = await db
    .select({ operation: runtimeOperations, sandbox: sandboxes })
    .from(runtimeOperations)
    .innerJoin(sandboxes, eq(sandboxes.id, runtimeOperations.sandboxId))
    .where(eq(runtimeOperations.id, operationId))
    .then((rows) => rows[0]);
  if (!row || terminalRuntimeOperationStates.has(row.operation.state)) return;
  const snapshot = row.sandbox.providerCapabilities ?? runtimeCapabilities(provider);
  const capabilities = provider.capabilities.runtime?.computer;
  const observed = snapshot as {
    computer?: {
      actions?: string[];
      screenshot?: { formats?: string[]; max_bytes?: number };
    };
  };
  const request = row.operation.request;
  const [claimed] = await db
    .update(runtimeOperations)
    .set({
      state: "running",
      startedAt: row.operation.startedAt ?? new Date(),
      providerCapabilities: snapshot,
      operationToken: guard.token,
    })
    .where(
      row.operation.state === "queued"
        ? and(eq(runtimeOperations.id, operationId), eq(runtimeOperations.state, "queued"))
        : and(
            eq(runtimeOperations.id, operationId),
            eq(runtimeOperations.state, "running"),
            sql`${runtimeOperations.operationToken} is not distinct from ${row.operation.operationToken}::uuid`,
          ),
    )
    .returning();
  if (!claimed) return;
  try {
    if (row.operation.state !== "queued") {
      throw new ProviderError(
        "computer operation was reclaimed without provider reconciliation support",
        "unknown_outcome",
        false,
      );
    }
    if (row.sandbox.status !== "ready" || !row.sandbox.providerResourceId) {
      throw sandboxNotReady(row.sandbox);
    }
    let result: Record<string, unknown>;
    if (row.operation.kind === "computer_action") {
      if (!capabilities || !observed.computer?.actions || !provider.executeComputerAction) {
        throw new ProviderError("computer actions are unsupported", "unsupported", false);
      }
      const actionType = String(request.type);
      if (
        !capabilities.actions.includes(actionType as never) ||
        !observed.computer.actions.includes(actionType)
      ) {
        throw new ProviderError(
          `computer action ${actionType} is unsupported`,
          "unsupported",
          false,
        );
      }
      const action =
        actionType === "mouse_drag"
          ? {
              type: "mouse_drag" as const,
              startX: Number(request.start_x),
              startY: Number(request.start_y),
              endX: Number(request.end_x),
              endY: Number(request.end_y),
              button: request.button as "left" | "right" | "middle",
            }
          : actionType === "keyboard_type"
            ? {
                type: "keyboard_type" as const,
                text: String(request.text),
                delayMs: Number(request.delay_ms),
              }
            : actionType === "keyboard_key"
              ? {
                  type: "keyboard_key" as const,
                  key: String(request.key),
                  modifiers: request.modifiers as ("ctrl" | "alt" | "shift" | "cmd")[],
                }
              : actionType === "keyboard_hotkey"
                ? { type: "keyboard_hotkey" as const, keys: String(request.keys) }
                : actionType === "mouse_scroll"
                  ? {
                      type: "mouse_scroll" as const,
                      direction: request.direction as "up" | "down",
                      amount: Number(request.amount),
                      x: request.x === undefined ? undefined : Number(request.x),
                      y: request.y === undefined ? undefined : Number(request.y),
                    }
                  : actionType === "mouse_click"
                    ? {
                        type: "mouse_click" as const,
                        x: Number(request.x),
                        y: Number(request.y),
                        button: request.button as "left" | "right" | "middle",
                        double: Boolean(request.double),
                      }
                    : {
                        type: "mouse_move" as const,
                        x: Number(request.x),
                        y: Number(request.y),
                      };
      await guard.assertOwned();
      await provider.executeComputerAction({
        providerResourceId: row.sandbox.providerResourceId,
        action,
      });
      result = { kind: "computer_action", performed: true };
    } else {
      if (
        !capabilities?.screenshot ||
        !observed.computer?.screenshot ||
        !provider.captureComputerScreenshot
      ) {
        throw new ProviderError("computer screenshots are unsupported", "unsupported", false);
      }
      const format = request.format as "png" | "jpeg";
      if (!capabilities.screenshot.formats.includes(format)) {
        throw new ProviderError(
          `computer screenshot format ${format} is unsupported`,
          "unsupported",
          false,
        );
      }
      if (!observed.computer.screenshot.formats?.includes(format)) {
        throw new ProviderError(
          `computer screenshot format ${format} was not observed for this sandbox`,
          "unsupported",
          false,
        );
      }
      const region = request.region as
        { x: number; y: number; width: number; height: number } | undefined;
      await guard.assertOwned();
      const screenshot = await provider.captureComputerScreenshot({
        providerResourceId: row.sandbox.providerResourceId,
        format,
        showCursor: Boolean(request.show_cursor),
        quality: request.quality === undefined ? undefined : Number(request.quality),
        scale: request.scale === undefined ? undefined : Number(request.scale),
        region,
      });
      if (screenshot.data.byteLength > capabilities.screenshot.maxBytes) {
        throw new ProviderError("computer screenshot exceeds provider limit", "unsupported", false);
      }
      result = {
        kind: "computer_screenshot",
        format: screenshot.format,
        data_base64: Buffer.from(screenshot.data).toString("base64"),
        byte_length: screenshot.data.byteLength,
        ...(screenshot.cursorPosition
          ? {
              cursor_position: {
                x: screenshot.cursorPosition.x,
                y: screenshot.cursorPosition.y,
              },
            }
          : {}),
      };
    }
    await guard.assertOwned();
    await db
      .update(runtimeOperations)
      .set({ state: "succeeded", result, error: null, completedAt: new Date() })
      .where(
        and(
          eq(runtimeOperations.id, operationId),
          eq(runtimeOperations.state, "running"),
          eq(runtimeOperations.operationToken, guard.token),
        ),
      );
  } catch (error) {
    if (error instanceof OutboxLeaseLostError) throw error;
    await db
      .update(runtimeOperations)
      .set({ state: "failed", error: runtimeError(error), completedAt: new Date() })
      .where(
        and(
          eq(runtimeOperations.id, operationId),
          eq(runtimeOperations.state, "running"),
          eq(runtimeOperations.operationToken, guard.token),
        ),
      );
    await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
  }
}

async function executeRecordingOperation(
  db: MetalDb,
  provider: SandboxProvider,
  recordingId: string,
  action: "start" | "stop",
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  const row = await db
    .select({ recording: sandboxRecordings, sandbox: sandboxes })
    .from(sandboxRecordings)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxRecordings.sandboxId))
    .where(eq(sandboxRecordings.id, recordingId))
    .then((rows) => rows[0]);
  if (!row || row.recording.state === "stopped" || row.recording.state === "failed") return;
  const expectedState = action === "start" ? "starting" : "stopping";
  if (row.recording.state !== expectedState) return;
  const snapshot = row.sandbox.providerCapabilities ?? runtimeCapabilities(provider);
  const [claimed] = await db
    .update(sandboxRecordings)
    .set({ operationToken: guard.token, providerCapabilities: snapshot, updatedAt: new Date() })
    .where(
      and(
        eq(sandboxRecordings.id, recordingId),
        eq(sandboxRecordings.state, expectedState),
        sql`${sandboxRecordings.operationToken} is not distinct from ${row.recording.operationToken}::uuid`,
      ),
    )
    .returning();
  if (!claimed) return;
  try {
    if (!row.sandbox.providerResourceId || row.sandbox.status !== "ready") {
      throw sandboxNotReady(row.sandbox);
    }
    const capabilities = provider.capabilities.runtime?.computer?.recording;
    const observed = snapshot as { computer?: { recording?: { formats?: string[] } } };
    if (
      !capabilities?.formats.includes("mp4") ||
      !observed.computer?.recording?.formats?.includes("mp4")
    ) {
      throw new ProviderError("MP4 recording is unsupported", "unsupported", false);
    }
    await guard.assertOwned();
    let result: ProviderComputerRecording | null | undefined;
    if (row.recording.operationToken) {
      result = await provider.reconcileComputerRecording?.({
        providerResourceId: row.sandbox.providerResourceId,
        recordingKey: row.recording.publicId,
        recordingId: row.recording.providerRecordingId ?? undefined,
      });
      if (!result) {
        throw new ProviderError(
          `recording ${action} outcome could not be reconciled`,
          "unknown_outcome",
          false,
        );
      }
      if (action === "stop" && result.state === "recording") {
        result = await provider.stopComputerRecording?.({
          providerResourceId: row.sandbox.providerResourceId,
          recordingId: result.recordingId,
        });
      }
    } else if (action === "start") {
      result = await provider.startComputerRecording?.({
        providerResourceId: row.sandbox.providerResourceId,
        recordingKey: row.recording.publicId,
        format: "mp4",
        label: row.recording.label ?? undefined,
      });
    } else if (row.recording.providerRecordingId) {
      result = await provider.stopComputerRecording?.({
        providerResourceId: row.sandbox.providerResourceId,
        recordingId: row.recording.providerRecordingId,
      });
    }
    if (!result) {
      throw new ProviderError(`recording ${action} is unsupported`, "unsupported", false);
    }
    await guard.assertOwned();
    await db
      .update(sandboxRecordings)
      .set({
        state: result.state,
        providerRecordingId: result.recordingId,
        filePath: result.filePath ?? row.recording.filePath,
        sizeBytes: result.sizeBytes ?? row.recording.sizeBytes,
        durationSeconds:
          result.durationSeconds === undefined
            ? row.recording.durationSeconds
            : Math.round(result.durationSeconds),
        startedAt: result.startedAt ?? row.recording.startedAt ?? new Date(),
        stoppedAt: result.state === "stopped" ? (result.stoppedAt ?? new Date()) : null,
        error: null,
        operationToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxRecordings.id, recordingId),
          eq(sandboxRecordings.operationToken, guard.token),
        ),
      );
  } catch (error) {
    if (error instanceof OutboxLeaseLostError) throw error;
    await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
    const classification = classifyProviderFailure(error);
    if (classification.retryable || classification.unknown) {
      throw error;
    }
    await db
      .update(sandboxRecordings)
      .set({
        state: "failed",
        error: runtimeError(error),
        operationToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxRecordings.id, recordingId),
          eq(sandboxRecordings.operationToken, guard.token),
        ),
      );
  }
}

async function createHttpEndpoint(
  db: MetalDb,
  provider: SandboxProvider,
  endpointId: string,
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  const row = await db
    .select({ endpoint: sandboxEndpoints, sandbox: sandboxes })
    .from(sandboxEndpoints)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxEndpoints.sandboxId))
    .where(eq(sandboxEndpoints.id, endpointId))
    .then((rows) => rows[0]);
  if (!row || row.endpoint.state !== "provisioning") return;
  const snapshot = runtimeCapabilities(provider);
  const [claimed] = await db
    .update(sandboxEndpoints)
    .set({ operationToken: guard.token, providerCapabilities: snapshot })
    .where(
      and(
        eq(sandboxEndpoints.id, endpointId),
        eq(sandboxEndpoints.state, "provisioning"),
        sql`${sandboxEndpoints.operationToken} is not distinct from ${row.endpoint.operationToken}::uuid`,
      ),
    )
    .returning();
  if (!claimed) return;
  let remoteLease:
    | {
        leaseId: string;
        url: string;
        expiresAt: Date;
      }
    | undefined;
  const revokeOrphan = async (leaseId: string) => {
    if (!row.sandbox.providerResourceId || !provider.revokeHttpEndpoint) return;
    const result = await provider
      .revokeHttpEndpoint({
        providerResourceId: row.sandbox.providerResourceId,
        leaseId,
      })
      .catch(() => null);
    if (result?.leaseId !== leaseId || !result.revoked) return;
    await withTransaction(db, async (tx) => {
      const [updated] = await tx
        .update(sandboxEndpoints)
        .set({ state: "revoked", revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(sandboxEndpoints.id, endpointId),
            eq(sandboxEndpoints.state, "revoking"),
            eq(sandboxEndpoints.operationToken, guard.token),
          ),
        )
        .returning({ id: sandboxEndpoints.id });
      if (updated) {
        await recordSandboxEvent(tx, row.sandbox, "endpoint.revoked", {
          endpoint_id: row.endpoint.publicId,
        });
      }
    });
  };
  try {
    const capability = provider.capabilities.runtime?.httpEndpoints;
    if (
      row.sandbox.status !== "ready" ||
      !row.sandbox.providerResourceId ||
      !capability?.expose ||
      !provider.exposeHttpEndpoint
    ) {
      throw new ProviderError("HTTP endpoints are unsupported", "unsupported", false);
    }
    const now = new Date();
    const leaseSeconds = Math.floor((claimed.leaseExpiresAt.getTime() - now.getTime()) / 1_000);
    if (leaseSeconds < 1) {
      return;
    }
    if (capability.maxLeaseDurationSeconds && leaseSeconds > capability.maxLeaseDurationSeconds) {
      throw new ProviderError("endpoint lease exceeds provider limit", "unsupported", false);
    }
    const persistedLeaseId =
      typeof claimed.providerMetadata.lease_id === "string"
        ? claimed.providerMetadata.lease_id
        : undefined;
    const persistedLeaseUrl =
      typeof claimed.providerMetadata.lease_url === "string"
        ? claimed.providerMetadata.lease_url
        : undefined;
    const persistedExpiry =
      typeof claimed.providerMetadata.lease_expires_at === "string"
        ? new Date(claimed.providerMetadata.lease_expires_at)
        : undefined;
    if (row.endpoint.operationToken) {
      if (persistedLeaseId) await revokeOrphan(persistedLeaseId);
      throw new ProviderError(
        "endpoint provisioning was reclaimed after provider exposure may have started",
        "unknown_outcome",
        false,
      );
    }
    if (persistedLeaseId && persistedLeaseUrl && persistedExpiry) {
      remoteLease = {
        leaseId: persistedLeaseId,
        url: persistedLeaseUrl,
        expiresAt: persistedExpiry,
      };
    } else {
      await guard.assertOwned();
      remoteLease = await provider.exposeHttpEndpoint({
        providerResourceId: row.sandbox.providerResourceId,
        port: row.endpoint.port,
        leaseDurationSeconds: leaseSeconds,
      });
    }
    if (
      !remoteLease.leaseId ||
      !/^https?:\/\//.test(remoteLease.url) ||
      !Number.isFinite(remoteLease.expiresAt.getTime()) ||
      remoteLease.expiresAt <= now ||
      remoteLease.expiresAt > claimed.leaseExpiresAt
    ) {
      throw new ProviderError(
        "provider returned an invalid or overlong endpoint lease",
        "unknown_outcome",
        false,
      );
    }
    await guard.assertOwned();
    const [metadataPersisted] = await db
      .update(sandboxEndpoints)
      .set({
        providerMetadata: {
          ...claimed.providerMetadata,
          lease_id: remoteLease.leaseId,
          lease_url: remoteLease.url,
          lease_expires_at: remoteLease.expiresAt.toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxEndpoints.id, endpointId),
          eq(sandboxEndpoints.state, "provisioning"),
          eq(sandboxEndpoints.operationToken, guard.token),
        ),
      )
      .returning({ id: sandboxEndpoints.id });
    if (!metadataPersisted) {
      await revokeOrphan(remoteLease.leaseId);
      return;
    }
    const activated = await withTransaction(db, async (tx) => {
      const [updated] = await tx
        .update(sandboxEndpoints)
        .set({
          state: "active",
          url: remoteLease!.url,
          providerCapabilities: snapshot,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sandboxEndpoints.id, endpointId),
            eq(sandboxEndpoints.state, "provisioning"),
            eq(sandboxEndpoints.operationToken, guard.token),
            sql`${sandboxEndpoints.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: sandboxEndpoints.id });
      if (!updated) return false;
      await recordSandboxEvent(tx, row.sandbox, "endpoint.created", {
        endpoint_id: row.endpoint.publicId,
        port: row.endpoint.port,
      });
      return true;
    });
    if (!activated) await revokeOrphan(remoteLease.leaseId);
  } catch (error) {
    if (error instanceof OutboxLeaseLostError) throw error;
    if (remoteLease) await revokeOrphan(remoteLease.leaseId);
    await withTransaction(db, async (tx) => {
      const safe = runtimeError(error, "endpoint_create_failed");
      if (classifyProviderFailure(error).unknown) safe.code = "provider_unknown_outcome";
      const [updated] = await tx
        .update(sandboxEndpoints)
        .set({
          state: "failed",
          error: safe,
          providerCapabilities: snapshot,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sandboxEndpoints.id, endpointId),
            eq(sandboxEndpoints.state, "provisioning"),
            eq(sandboxEndpoints.operationToken, guard.token),
          ),
        )
        .returning({ id: sandboxEndpoints.id });
      if (!updated) return;
      if (row.endpoint.state !== "failed") {
        await recordSandboxEvent(tx, row.sandbox, "endpoint.failed", {
          endpoint_id: row.endpoint.publicId,
          code: safe.code,
        });
      }
    });
    await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
  }
}

async function revokeHttpEndpoint(
  db: MetalDb,
  provider: SandboxProvider,
  endpointId: string,
  guard: JobLeaseGuard,
) {
  await guard.assertOwned();
  const row = await db
    .select({ endpoint: sandboxEndpoints, sandbox: sandboxes })
    .from(sandboxEndpoints)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxEndpoints.sandboxId))
    .where(eq(sandboxEndpoints.id, endpointId))
    .then((rows) => rows[0]);
  if (
    !row ||
    (row.endpoint.state !== "revoking" &&
      row.endpoint.state !== "expired" &&
      row.endpoint.state !== "failed")
  )
    return;
  const expired = row.endpoint.state === "expired" || row.endpoint.leaseExpiresAt <= new Date();
  const [claimed] = await db
    .update(sandboxEndpoints)
    .set({ operationToken: guard.token })
    .where(
      and(
        eq(sandboxEndpoints.id, endpointId),
        inArray(sandboxEndpoints.state, ["revoking", "expired", "failed"]),
        sql`${sandboxEndpoints.operationToken} is not distinct from ${row.endpoint.operationToken}::uuid`,
      ),
    )
    .returning();
  if (!claimed) return;
  const leaseId =
    typeof claimed.providerMetadata.lease_id === "string"
      ? claimed.providerMetadata.lease_id
      : undefined;
  try {
    const canRevoke =
      provider.capabilities.runtime?.httpEndpoints?.revoke && provider.revokeHttpEndpoint;
    if (leaseId && !canRevoke) {
      throw new ProviderError("HTTP endpoint revocation is unsupported", "unsupported", false);
    }
    if (leaseId && row.sandbox.providerResourceId && canRevoke) {
      await guard.assertOwned();
      const result = await provider.revokeHttpEndpoint!({
        providerResourceId: row.sandbox.providerResourceId,
        leaseId,
      });
      if (result.leaseId !== leaseId || !result.revoked) {
        throw new ProviderError(
          "provider did not confirm HTTP endpoint revocation",
          "unknown_outcome",
          true,
        );
      }
    } else if (leaseId) {
      throw new ProviderError(
        "HTTP endpoint revocation could not be verified",
        "unknown_outcome",
        true,
      );
    }
    await guard.assertOwned();
    await withTransaction(db, async (tx) => {
      const [updated] = await tx
        .update(sandboxEndpoints)
        .set({
          state: expired ? "expired" : "revoked",
          revokedAt: row.endpoint.revokedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sandboxEndpoints.id, endpointId),
            eq(sandboxEndpoints.operationToken, guard.token),
            inArray(sandboxEndpoints.state, ["revoking", "expired", "failed"]),
          ),
        )
        .returning({ id: sandboxEndpoints.id });
      if (!updated) return;
      if (!expired) {
        await recordSandboxEvent(tx, row.sandbox, "endpoint.revoked", {
          endpoint_id: row.endpoint.publicId,
        });
      }
    });
  } catch (error) {
    if (error instanceof OutboxLeaseLostError) throw error;
    const safe = runtimeError(error, "endpoint_revoke_failed");
    await withTransaction(db, async (tx) => {
      const [updated] = await tx
        .update(sandboxEndpoints)
        .set({ state: "failed", error: safe, updatedAt: new Date() })
        .where(
          and(
            eq(sandboxEndpoints.id, endpointId),
            eq(sandboxEndpoints.operationToken, guard.token),
            inArray(sandboxEndpoints.state, ["revoking", "expired", "failed"]),
          ),
        )
        .returning({ id: sandboxEndpoints.id });
      if (!updated) return;
      if (row.endpoint.state !== "failed") {
        await recordSandboxEvent(tx, row.sandbox, "endpoint.failed", {
          endpoint_id: row.endpoint.publicId,
          code: safe.code,
        });
      }
    });
    await reconcileProviderSandboxState(db, provider, row.sandbox.id, error);
    if (safe.retryable) throw error;
  }
}

async function scheduleExpiredEndpoints(db: MetalDb, now = new Date()) {
  await withTransaction(db, async (tx) => {
    const expired = await tx
      .update(sandboxEndpoints)
      .set({ state: "expired", updatedAt: now })
      .where(
        and(
          inArray(sandboxEndpoints.state, ["provisioning", "active"]),
          lte(sandboxEndpoints.leaseExpiresAt, now),
        ),
      )
      .returning();
    for (const endpoint of expired) {
      const sandbox = await tx
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.id, endpoint.sandboxId))
        .then((rows) => rows[0]);
      if (sandbox) {
        await recordSandboxEvent(tx, sandbox, "endpoint.expired", {
          endpoint_id: endpoint.publicId,
        });
      }
      await tx
        .insert(outboxJobs)
        .values({
          jobType: "endpoint.revoke",
          dedupeKey: `endpoint:expire:${endpoint.id}`,
          payload: { job_type: "endpoint.revoke", endpoint_id: endpoint.id },
        })
        .onConflictDoNothing();
    }
  });
}

async function cleanupExpiredProcessEvents(db: MetalDb, retentionMs: number) {
  await db.execute(sql`
    delete from metal.process_events
    where id in (
      select events.id
      from metal.process_events events
      inner join metal.sandbox_processes processes on processes.id = events.process_id
      where processes.state in ('succeeded', 'failed', 'cancelled', 'timed_out')
        and processes.completed_at < now() - (${retentionMs} * interval '1 millisecond')
      order by processes.completed_at, events.sequence
      limit 1000
    )
  `);
}

async function recordTerminalSandboxFailure(
  db: MetalDb,
  payload: Exclude<
    OutboxJobPayload,
    { job_type: "realtime.broadcast" } | { job_type: "webhook.deliver" }
  >,
) {
  if (
    payload.job_type !== "sandbox.provision" &&
    payload.job_type !== "sandbox.reconcile" &&
    payload.job_type !== "sandbox.pause" &&
    payload.job_type !== "sandbox.resume" &&
    payload.job_type !== "sandbox.destroy"
  ) {
    return;
  }
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, payload.sandbox_id))
    .then((rows) => rows[0]);
  if (!sandbox || sandbox.status === "stopped" || sandbox.status === "deleted") {
    return;
  }
  const status =
    payload.job_type === "sandbox.destroy"
      ? "cleanup_failed"
      : payload.job_type === "sandbox.pause"
        ? "ready"
        : payload.job_type === "sandbox.resume"
          ? "paused"
          : "failed";
  await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(sandboxes)
      .set({
        status,
        errorCode: `${payload.job_type.replace(".", "_")}_failed`,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    if (updated) {
      await recordSandboxEvent(tx, updated, "sandbox.failed", {
        operation: payload.job_type,
        error_code: updated.errorCode,
      });
    }
  });
}

async function recordTerminalRuntimeFailure(
  db: MetalDb,
  payload: Exclude<
    OutboxJobPayload,
    { job_type: "realtime.broadcast" } | { job_type: "webhook.deliver" }
  >,
  error: unknown,
  guard: JobLeaseGuard,
) {
  const safe = runtimeError(
    error,
    payload.job_type === "endpoint.create"
      ? "endpoint_create_failed"
      : payload.job_type === "endpoint.revoke"
        ? "endpoint_revoke_failed"
        : "runtime_operation_failed",
  );
  if (payload.job_type === "process.execute" || payload.job_type === "process.cancel") {
    const process = await db
      .select({ timeoutSeconds: sandboxProcesses.timeoutSeconds })
      .from(sandboxProcesses)
      .where(eq(sandboxProcesses.id, payload.process_id))
      .then((rows) => rows[0]);
    if (process) await failProcess(db, payload.process_id, guard, error, process.timeoutSeconds);
    return;
  }
  if (
    payload.job_type === "filesystem.read" ||
    payload.job_type === "filesystem.write" ||
    payload.job_type === "filesystem.list" ||
    payload.job_type === "filesystem.delete" ||
    payload.job_type === "computer.action" ||
    payload.job_type === "computer.screenshot"
  ) {
    await db
      .update(runtimeOperations)
      .set({ state: "failed", error: safe, completedAt: new Date() })
      .where(
        and(
          eq(runtimeOperations.id, payload.runtime_operation_id),
          or(
            eq(runtimeOperations.operationToken, guard.token),
            isNull(runtimeOperations.operationToken),
          ),
          inArray(runtimeOperations.state, ["queued", "running"]),
        ),
      );
    return;
  }
  if (payload.job_type === "recording.start" || payload.job_type === "recording.stop") {
    await db
      .update(sandboxRecordings)
      .set({ state: "failed", error: safe, operationToken: null, updatedAt: new Date() })
      .where(
        and(
          eq(sandboxRecordings.id, payload.recording_id),
          or(
            eq(sandboxRecordings.operationToken, guard.token),
            isNull(sandboxRecordings.operationToken),
          ),
          inArray(sandboxRecordings.state, ["starting", "recording", "stopping"]),
        ),
      );
    return;
  }
  if (payload.job_type === "endpoint.create" || payload.job_type === "endpoint.revoke") {
    await db
      .update(sandboxEndpoints)
      .set({ state: "failed", error: safe, updatedAt: new Date() })
      .where(
        and(
          eq(sandboxEndpoints.id, payload.endpoint_id),
          eq(sandboxEndpoints.operationToken, guard.token),
          inArray(sandboxEndpoints.state, ["provisioning", "revoking", "expired"]),
        ),
      );
  }
}

async function resolveSandboxProvider(
  db: MetalDb,
  providers: SandboxProviders,
  sandboxId: string,
): Promise<SandboxProvider> {
  const sandbox = await db
    .select({
      provider: sandboxes.provider,
      providerCredentialId: sandboxes.providerCredentialId,
    })
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .then((rows) => rows[0]);
  if (sandbox?.providerCredentialId) {
    return getByokProviderByCredentialId(db, sandbox.providerCredentialId);
  }
  const provider = sandbox ? providers[sandbox.provider as SandboxProviderName] : undefined;
  if (!provider) {
    throw new Error(
      sandbox ? `${sandbox.provider} sandbox provider is not configured` : "sandbox not found",
    );
  }
  return provider;
}

async function runtimeSandboxId(
  db: MetalDb,
  payload:
    | Extract<OutboxJobPayload, { job_type: "process.execute" | "process.cancel" }>
    | Extract<
        OutboxJobPayload,
        {
          job_type:
            | "filesystem.read"
            | "filesystem.write"
            | "filesystem.list"
            | "filesystem.delete"
            | "computer.action"
            | "computer.screenshot";
        }
      >
    | Extract<OutboxJobPayload, { job_type: "endpoint.create" | "endpoint.revoke" }>
    | Extract<OutboxJobPayload, { job_type: "recording.start" | "recording.stop" }>,
) {
  if (payload.job_type === "process.execute" || payload.job_type === "process.cancel") {
    return db
      .select({ sandboxId: sandboxProcesses.sandboxId })
      .from(sandboxProcesses)
      .where(eq(sandboxProcesses.id, payload.process_id))
      .then((rows) => rows[0]?.sandboxId);
  }
  if (payload.job_type === "endpoint.create" || payload.job_type === "endpoint.revoke") {
    return db
      .select({ sandboxId: sandboxEndpoints.sandboxId })
      .from(sandboxEndpoints)
      .where(eq(sandboxEndpoints.id, payload.endpoint_id))
      .then((rows) => rows[0]?.sandboxId);
  }
  if (payload.job_type === "recording.start" || payload.job_type === "recording.stop") {
    return db
      .select({ sandboxId: sandboxRecordings.sandboxId })
      .from(sandboxRecordings)
      .where(eq(sandboxRecordings.id, payload.recording_id))
      .then((rows) => rows[0]?.sandboxId);
  }
  return db
    .select({ sandboxId: runtimeOperations.sandboxId })
    .from(runtimeOperations)
    .where(eq(runtimeOperations.id, payload.runtime_operation_id))
    .then((rows) => rows[0]?.sandboxId);
}

export async function processOnce(
  db: MetalDb,
  publisher: BroadcastPublisher,
  env: WorkerEnv,
  providers: SandboxProviders = {},
  stripe: StripeGateway | null = null,
): Promise<number> {
  const logger = createLogger({
    service: "worker",
    environment: env.METAL_ENVIRONMENT,
    level: env.LOG_LEVEL,
  });
  await scheduleExpiredEndpoints(db);
  await cleanupExpiredProcessEvents(db, env.WORKER_PROCESS_EVENT_RETENTION_MS);
  const jobs = await claimOutboxJobs(db, {
    workerId: env.WORKER_ID,
    limit: env.WORKER_BATCH_SIZE,
    leaseMs: env.WORKER_LEASE_MS,
  });
  const guards = new Map(
    jobs.map((job) => [job.id, createJobLeaseGuard(db, job, env.WORKER_ID, env.WORKER_LEASE_MS)]),
  );
  const webhookJobs = jobs.filter((job) => job.jobType === "webhook.deliver");
  const sequentialJobs = jobs.filter((job) => job.jobType !== "webhook.deliver");

  for (const job of sequentialJobs) {
    const guard = guards.get(job.id)!;
    const child = logger.child({
      job_id: job.id,
      service: "worker",
      environment: env.METAL_ENVIRONMENT,
    });
    let payload: OutboxJobPayload | undefined;
    try {
      payload = OutboxJobPayloadSchema.parse(job.payload);
      if (payload.job_type === "realtime.broadcast") {
        await publisher.publish(payload.topic, payload.event.type, payload.event);
      } else if (payload.job_type === "billing.auto_topup.evaluate") {
        if (!stripe) {
          throw new Error("stripe is not configured for automatic top ups");
        }
        await evaluateAutoTopup(db, stripe, payload.organization_id);
      } else if (payload.job_type === "billing.spend_limit.enforce") {
        const organizationId = payload.organization_id;
        await withTransaction(db, (tx) => enforceSpendLimit(tx, organizationId));
      } else if (payload.job_type === "sandbox.provision") {
        await provisionSandbox(db, providers, payload.sandbox_id, payload.operation_id);
      } else if (payload.job_type === "sandbox.reconcile") {
        await provisionSandbox(db, providers, payload.sandbox_id, payload.operation_id);
      } else if (payload.job_type === "sandbox.pause") {
        const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
        await pauseSandbox(db, sandboxProvider, payload.sandbox_id, payload.operation_id);
      } else if (payload.job_type === "sandbox.resume") {
        const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
        await resumeSandbox(db, sandboxProvider, payload.sandbox_id, payload.operation_id);
      } else if (payload.job_type === "sandbox.cost.sync") {
        const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
        await syncSandboxCost(db, sandboxProvider, payload.sandbox_id, payload.final);
      } else if (payload.job_type === "sandbox.destroy") {
        const sandboxProvider = await resolveSandboxProvider(db, providers, payload.sandbox_id);
        await destroySandbox(db, sandboxProvider, payload.sandbox_id, payload.operation_id);
      } else if (payload.job_type === "webhook.deliver") {
        throw new Error("webhook.deliver jobs are processed outside the sequential path");
      } else {
        const sandboxId = await runtimeSandboxId(db, payload);
        if (sandboxId) {
          const sandboxProvider = await resolveSandboxProvider(db, providers, sandboxId);
          if (payload.job_type === "process.execute") {
            await executeProcess(db, sandboxProvider, payload.process_id, guard);
          } else if (payload.job_type === "process.cancel") {
            await cancelProcessExecution(db, sandboxProvider, payload.process_id, guard);
          } else if (
            payload.job_type === "filesystem.read" ||
            payload.job_type === "filesystem.write" ||
            payload.job_type === "filesystem.list" ||
            payload.job_type === "filesystem.delete"
          ) {
            await executeFilesystemOperation(
              db,
              sandboxProvider,
              payload.runtime_operation_id,
              guard,
            );
          } else if (
            payload.job_type === "computer.action" ||
            payload.job_type === "computer.screenshot"
          ) {
            await executeComputerOperation(
              db,
              sandboxProvider,
              payload.runtime_operation_id,
              guard,
            );
          } else if (
            payload.job_type === "recording.start" ||
            payload.job_type === "recording.stop"
          ) {
            await executeRecordingOperation(
              db,
              sandboxProvider,
              payload.recording_id,
              payload.job_type === "recording.start" ? "start" : "stop",
              guard,
            );
          } else if (payload.job_type === "endpoint.create") {
            await createHttpEndpoint(db, sandboxProvider, payload.endpoint_id, guard);
          } else {
            await revokeHttpEndpoint(db, sandboxProvider, payload.endpoint_id, guard);
          }
        }
      }
      await db
        .update(outboxJobs)
        .set({
          status: "succeeded",
          completedAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
        })
        .where(
          and(
            eq(outboxJobs.id, job.id),
            eq(outboxJobs.status, "leased"),
            eq(outboxJobs.leaseOwner, env.WORKER_ID),
            eq(outboxJobs.leaseToken, guard.token),
          ),
        );
      child.info({ job_id: job.id, job_type: payload.job_type }, "processed outbox job");
    } catch (error) {
      if (error instanceof OutboxLeaseLostError) {
        child.warn({ job_id: job.id }, "outbox lease lost; stale worker stopped");
        continue;
      }
      const attempts = job.attemptCount;
      const maxAttemptsReached = attempts >= env.WORKER_MAX_ATTEMPTS;
      const durableProvisionReconciliation =
        maxAttemptsReached &&
        payload &&
        (payload.job_type === "sandbox.provision" || payload.job_type === "sandbox.reconcile") &&
        (await db
          .select({ status: sandboxes.status })
          .from(sandboxes)
          .where(eq(sandboxes.id, payload.sandbox_id))
          .then((rows) => rows[0]?.status)) === "provision_unknown";
      const terminal = maxAttemptsReached && !durableProvisionReconciliation;
      const retryDelayMs = durableProvisionReconciliation
        ? 5 * 60_000
        : payload?.job_type === "sandbox.cost.sync" && payload.final
          ? 2 * 60_000
          : backoffMs(attempts, env.WORKER_BASE_BACKOFF_MS);
      if (
        terminal &&
        payload &&
        payload.job_type !== "realtime.broadcast" &&
        payload.job_type !== "webhook.deliver"
      ) {
        await recordTerminalSandboxFailure(db, payload);
        await recordTerminalRuntimeFailure(db, payload, error, guard);
        if ("operation_id" in payload && payload.operation_id) {
          await setOperationState(db, payload.operation_id, "failed", {
            code: "operation_failed",
            message: safeError(error),
            retryable: false,
          });
        }
      }
      await db
        .update(outboxJobs)
        .set({
          status: terminal ? "failed" : "pending",
          lastError: safeError(error),
          availableAt: terminal ? new Date() : new Date(Date.now() + retryDelayMs),
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          updatedAt: new Date(),
          completedAt: terminal ? new Date() : null,
        })
        .where(
          and(
            eq(outboxJobs.id, job.id),
            eq(outboxJobs.status, "leased"),
            eq(outboxJobs.leaseOwner, env.WORKER_ID),
            eq(outboxJobs.leaseToken, guard.token),
          ),
        );
      child.warn(
        { job_id: job.id, attempt: attempts, terminal, err: safeError(error) },
        "outbox job failed",
      );
    } finally {
      guard.stop();
    }
  }

  await runWithConcurrency(webhookJobs, env.WORKER_WEBHOOK_CONCURRENCY, async (job) => {
    const guard = guards.get(job.id)!;
    const child = logger.child({
      job_id: job.id,
      service: "worker",
      environment: env.METAL_ENVIRONMENT,
    });
    try {
      const payload = OutboxJobPayloadSchema.parse(job.payload);
      if (payload.job_type !== "webhook.deliver") {
        throw new Error(`unexpected job type ${payload.job_type} on the webhook path`);
      }
      const disposition = await deliverWebhookOnce(db, payload.delivery_id, {
        policy: webhookUrlPolicyForEnvironment(env.METAL_ENVIRONMENT),
        maxAttempts: env.WORKER_WEBHOOK_MAX_ATTEMPTS,
        baseBackoffMs: env.WORKER_WEBHOOK_BASE_BACKOFF_MS,
      });
      await settleWebhookJob(db, job, env.WORKER_ID, guard.token, disposition);
      child.info({ job_id: job.id, job_type: payload.job_type }, "processed outbox job");
    } catch (error) {
      if (error instanceof OutboxLeaseLostError) {
        child.warn({ job_id: job.id }, "outbox lease lost; stale worker stopped");
        return;
      }
      const attempts = job.attemptCount;
      const terminal = attempts >= env.WORKER_MAX_ATTEMPTS;
      await db
        .update(outboxJobs)
        .set({
          status: terminal ? "failed" : "pending",
          lastError: safeError(error),
          availableAt: terminal
            ? new Date()
            : new Date(Date.now() + backoffMs(attempts, env.WORKER_BASE_BACKOFF_MS)),
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          updatedAt: new Date(),
          completedAt: terminal ? new Date() : null,
        })
        .where(
          and(
            eq(outboxJobs.id, job.id),
            eq(outboxJobs.status, "leased"),
            eq(outboxJobs.leaseOwner, env.WORKER_ID),
            eq(outboxJobs.leaseToken, guard.token),
          ),
        );
      child.warn(
        { job_id: job.id, attempt: attempts, terminal, err: safeError(error) },
        "webhook outbox job failed",
      );
    } finally {
      guard.stop();
    }
  });

  return jobs.length;
}

async function scheduleMissingSandboxCosts(db: MetalDb, providers: SandboxProviders, now: Date) {
  const activeJobs = await db
    .select({ payload: outboxJobs.payload })
    .from(outboxJobs)
    .where(
      and(
        eq(outboxJobs.jobType, "sandbox.cost.sync"),
        inArray(outboxJobs.status, ["pending", "leased"]),
      ),
    );
  const activeSandboxIds = new Set<string>();
  const credentialProviders = new Map<string, SandboxProvider>();
  for (const job of activeJobs) {
    const parsed = OutboxJobPayloadSchema.safeParse(job.payload);
    if (parsed.success && parsed.data.job_type === "sandbox.cost.sync") {
      activeSandboxIds.add(parsed.data.sandbox_id);
    }
  }

  const missingCosts = await db
    .select({
      id: sandboxes.id,
      status: sandboxes.status,
      provider: sandboxes.provider,
      providerCredentialId: sandboxes.providerCredentialId,
      pausedAt: sandboxes.pausedAt,
      deletedAt: sandboxes.deletedAt,
    })
    .from(sandboxes)
    .where(
      and(
        isNotNull(sandboxes.providerResourceId),
        sql`(
          ${sandboxes.providerCostUpdatedAt} is null
          or (
            ${sandboxes.status} = 'deleted'
            and ${sandboxes.deletedAt} is not null
            and (
              ${sandboxes.providerCostMeasuredThrough} is null
              or ${sandboxes.providerCostMeasuredThrough} < ${sandboxes.deletedAt}
            )
          )
          or (
            ${sandboxes.status} = 'paused'
            and ${sandboxes.pausedAt} is not null
            and (
              ${sandboxes.providerCostMeasuredThrough} is null
              or ${sandboxes.providerCostMeasuredThrough} < ${sandboxes.pausedAt}
            )
          )
        )`,
      ),
    );
  for (const sandbox of missingCosts) {
    if (activeSandboxIds.has(sandbox.id)) {
      continue;
    }
    let provider = providers[sandbox.provider as SandboxProviderName];
    if (sandbox.providerCredentialId) {
      provider = credentialProviders.get(sandbox.providerCredentialId);
      if (!provider) {
        provider = await getByokProviderByCredentialId(db, sandbox.providerCredentialId);
        credentialProviders.set(sandbox.providerCredentialId, provider);
      }
    }
    if (!provider?.capabilities.cost) {
      continue;
    }
    if (provider.name === "northflank" && sandbox.status === "ready") {
      continue;
    }
    const final =
      sandbox.status === "stopped" ||
      sandbox.status === "deleted" ||
      ((provider.name === "codesandbox" || provider.name === "northflank") &&
        sandbox.status === "paused");
    const measuredThrough = sandbox.deletedAt ?? sandbox.pausedAt;
    const providerAvailableAt =
      provider.name === "northflank" && final && measuredThrough
        ? northflankBillingAvailableAt(measuredThrough)
        : now;
    await scheduleCostSync(
      db,
      sandbox.id,
      new Date(Math.max(providerAvailableAt.getTime(), now.getTime())),
      final,
    );
  }
}

export async function runWorkerLoop(
  db: MetalDb,
  publisher: BroadcastPublisher,
  env: WorkerEnv,
  signal: AbortSignal,
  providers: SandboxProviders = {},
): Promise<void> {
  const stripe = env.STRIPE_SECRET_KEY ? createStripeGateway(env.STRIPE_SECRET_KEY) : null;
  let nextCostSweepAt = 0;
  while (!signal.aborted) {
    const now = Date.now();
    if (now >= nextCostSweepAt) {
      const sweepBucket = Math.floor(now / env.WORKER_COST_SWEEP_MS) * env.WORKER_COST_SWEEP_MS;
      await scheduleMissingSandboxCosts(db, providers, new Date(sweepBucket));
      nextCostSweepAt = sweepBucket + env.WORKER_COST_SWEEP_MS;
    }
    await processOnce(db, publisher, env, providers, stripe);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, env.WORKER_POLL_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}
