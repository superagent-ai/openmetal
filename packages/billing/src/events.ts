import { organizationTopic } from "@openmetal/events";
import { insertDomainEventAndBroadcast, type MetalDb } from "@openmetal/db";

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
  const { eventId } = await insertDomainEventAndBroadcast(tx, {
    type: input.type,
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    data: input.data,
    topic: organizationTopic(input.organizationId),
  });
  return eventId;
}
