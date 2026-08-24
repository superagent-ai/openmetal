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
export const OutboxJobPayloadSchema = z.discriminatedUnion("job_type", [
  RealtimeBroadcastJobPayloadSchema,
  SandboxProvisionJobPayloadSchema,
  SandboxReconcileJobPayloadSchema,
  SandboxPauseJobPayloadSchema,
  SandboxResumeJobPayloadSchema,
  SandboxCostSyncJobPayloadSchema,
  SandboxDestroyJobPayloadSchema,
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
