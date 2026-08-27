import { z } from "zod";
import { DurableEventEnvelopeSchema } from "@openmetal/contracts";

export const OutboxJobTypeSchema = z.enum([
  "realtime.broadcast",
  "sandbox.provision",
  "sandbox.reconcile",
  "sandbox.pause",
  "sandbox.resume",
  "sandbox.cost.sync",
  "sandbox.destroy",
  "process.execute",
  "process.cancel",
  "filesystem.read",
  "filesystem.write",
  "filesystem.list",
  "filesystem.delete",
  "endpoint.create",
  "endpoint.revoke",
  "billing.auto_topup.evaluate",
  "billing.spend_limit.enforce",
]);
export type OutboxJobType = z.infer<typeof OutboxJobTypeSchema>;

export const RealtimeBroadcastJobPayloadSchema = z.object({
  job_type: z.literal("realtime.broadcast"),
  topic: z.string().min(1),
  event: DurableEventEnvelopeSchema,
});
export const SandboxProvisionJobPayloadSchema = z.object({
  job_type: z.literal("sandbox.provision"),
  sandbox_id: z.uuid(),
  operation_id: z.uuid(),
});
export const SandboxReconcileJobPayloadSchema = z.object({
  job_type: z.literal("sandbox.reconcile"),
  sandbox_id: z.uuid(),
  operation_id: z.uuid(),
  attempt_index: z.number().int().nonnegative(),
});
export const SandboxDestroyJobPayloadSchema = z.object({
  job_type: z.literal("sandbox.destroy"),
  sandbox_id: z.uuid(),
  operation_id: z.uuid().optional(),
});
export const SandboxPauseJobPayloadSchema = z.object({
  job_type: z.literal("sandbox.pause"),
  sandbox_id: z.uuid(),
  operation_id: z.uuid(),
});
export const SandboxResumeJobPayloadSchema = z.object({
  job_type: z.literal("sandbox.resume"),
  sandbox_id: z.uuid(),
  operation_id: z.uuid(),
});
export const SandboxCostSyncJobPayloadSchema = z.object({
  job_type: z.literal("sandbox.cost.sync"),
  sandbox_id: z.uuid(),
  final: z.boolean().default(false),
});
export const ProcessExecuteJobPayloadSchema = z.object({
  job_type: z.literal("process.execute"),
  process_id: z.uuid(),
});
export const ProcessCancelJobPayloadSchema = z.object({
  job_type: z.literal("process.cancel"),
  process_id: z.uuid(),
});
export const FilesystemReadJobPayloadSchema = z.object({
  job_type: z.literal("filesystem.read"),
  runtime_operation_id: z.uuid(),
});
export const FilesystemWriteJobPayloadSchema = z.object({
  job_type: z.literal("filesystem.write"),
  runtime_operation_id: z.uuid(),
});
export const FilesystemListJobPayloadSchema = z.object({
  job_type: z.literal("filesystem.list"),
  runtime_operation_id: z.uuid(),
});
export const FilesystemDeleteJobPayloadSchema = z.object({
  job_type: z.literal("filesystem.delete"),
  runtime_operation_id: z.uuid(),
});
export const EndpointCreateJobPayloadSchema = z.object({
  job_type: z.literal("endpoint.create"),
  endpoint_id: z.uuid(),
});
export const EndpointRevokeJobPayloadSchema = z.object({
  job_type: z.literal("endpoint.revoke"),
  endpoint_id: z.uuid(),
});
export const BillingAutoTopupEvaluateJobPayloadSchema = z.object({
  job_type: z.literal("billing.auto_topup.evaluate"),
  organization_id: z.uuid(),
  reason: z.string().min(1),
});
export const BillingSpendLimitEnforceJobPayloadSchema = z.object({
  job_type: z.literal("billing.spend_limit.enforce"),
  organization_id: z.uuid(),
  reason: z.string().min(1),
});
export const OutboxJobPayloadSchema = z.discriminatedUnion("job_type", [
  RealtimeBroadcastJobPayloadSchema,
  SandboxProvisionJobPayloadSchema,
  SandboxReconcileJobPayloadSchema,
  SandboxPauseJobPayloadSchema,
  SandboxResumeJobPayloadSchema,
  SandboxCostSyncJobPayloadSchema,
  SandboxDestroyJobPayloadSchema,
  ProcessExecuteJobPayloadSchema,
  ProcessCancelJobPayloadSchema,
  FilesystemReadJobPayloadSchema,
  FilesystemWriteJobPayloadSchema,
  FilesystemListJobPayloadSchema,
  FilesystemDeleteJobPayloadSchema,
  EndpointCreateJobPayloadSchema,
  EndpointRevokeJobPayloadSchema,
  BillingAutoTopupEvaluateJobPayloadSchema,
  BillingSpendLimitEnforceJobPayloadSchema,
]);
export type OutboxJobPayload = z.infer<typeof OutboxJobPayloadSchema>;

export function validateOutboxPayload(input: unknown): OutboxJobPayload {
  return OutboxJobPayloadSchema.parse(input);
}

export function publicationDedupeKey(eventId: string): string {
  return `broadcast:${eventId}`;
}

export function isDuplicateDelivery(seen: Set<string>, eventId: string, cursor: string): boolean {
  const key = `${eventId}:${cursor}`;
  if (seen.has(key) || seen.has(eventId)) {
    return true;
  }
  seen.add(key);
  seen.add(eventId);
  return false;
}
