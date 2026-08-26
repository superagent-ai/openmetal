import {
  organizationTopic,
  publicationDedupeKey,
  serializeCursor,
  toPublicEvent,
} from "@openmetal/events";
import { domainEvents, outboxJobs, type MetalDb } from "@openmetal/db";

export async function recordBillingEvent(
  tx: MetalDb,
  input: {
    type: string;
    organizationId: string;
    projectId?: string;
    actorId: string;
    data: Record<string, unknown>;
  },
) {
  const [event] = await tx
    .insert(domainEvents)
    .values({
      type: input.type,
      organizationId: input.organizationId,
      projectId: input.projectId,
      actorId: input.actorId,
      payload: input.data,
    })
    .returning();
  if (!event) {
    throw new Error("failed to persist billing event");
  }
  const publicEvent = toPublicEvent({
    cursor: serializeCursor(event.cursor),
    eventId: event.eventId,
    type: event.type,
    organizationId: event.organizationId,
    projectId: event.projectId ? `prj_${event.projectId.replaceAll("-", "")}` : undefined,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
  await tx.insert(outboxJobs).values({
    jobType: "realtime.broadcast",
    dedupeKey: publicationDedupeKey(event.eventId),
    payload: {
      job_type: "realtime.broadcast",
      topic: organizationTopic(input.organizationId),
      event: publicEvent,
    },
  });
  return event;
}
