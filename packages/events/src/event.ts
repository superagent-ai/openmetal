import { DurableEventEnvelopeSchema, type DurableEventEnvelope } from "@openmetal/contracts";
import { redactRecord } from "@openmetal/logger";
import { z } from "zod";

export const EventTypeValues = [
  "organization.created",
  "project.created",
  "project.deleted",
  "project.updated",
] as const;
export const EventTypeValueSchema = z.enum(EventTypeValues);
export type EventTypeValue = z.infer<typeof EventTypeValueSchema>;

export const CreateDomainEventInputSchema = z.object({
  type: EventTypeValueSchema,
  organizationId: z.uuid(),
  projectId: z.uuid().optional(),
  actorId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
  occurredAt: z.date().optional(),
});
export type CreateDomainEventInput = z.infer<typeof CreateDomainEventInputSchema>;

export function parsePublicEvent(input: unknown): DurableEventEnvelope {
  return DurableEventEnvelopeSchema.parse(input);
}

export function toPublicEvent(input: {
  cursor: string;
  eventId: string;
  type: string;
  organizationId: string;
  projectId?: string | null;
  occurredAt: Date | string;
  data: Record<string, unknown>;
}): DurableEventEnvelope {
  return DurableEventEnvelopeSchema.parse({
    cursor: input.cursor,
    event_id: input.eventId,
    type: input.type,
    organization_id: input.organizationId,
    project_id: input.projectId ?? undefined,
    occurred_at:
      input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt,
    data: redactRecord(input.data) as Record<string, unknown>,
  });
}

export function redactEventData(data: Record<string, unknown>): Record<string, unknown> {
  return redactRecord(data);
}
