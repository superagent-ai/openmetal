import { z } from "zod";
import { DurableEventEnvelopeSchema } from "@openmetal/contracts";

export const OutboxJobTypeSchema = z.literal("realtime.broadcast");
export type OutboxJobType = z.infer<typeof OutboxJobTypeSchema>;

export const OutboxJobPayloadSchema = z.object({
  job_type: OutboxJobTypeSchema,
  topic: z.string().min(1),
  event: DurableEventEnvelopeSchema,
});
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
