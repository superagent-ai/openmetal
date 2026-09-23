import { and, eq, isNull } from "drizzle-orm";
import {
  matchesWebhookEndpoint,
  organizationTopic,
  projectTopic,
  serializeCursor,
  toPublicEvent,
  webhookDedupeKey,
  webhookDeliveryDedupeKey,
} from "@openmetal/events";
import type { DurableEventEnvelope } from "@openmetal/contracts";
import { domainEvents, outboxJobs, webhookDeliveries, webhookEndpoints } from "./schema.js";
import type { MetalDb } from "./client.js";
import { sendRealtimeBroadcast } from "./realtime.js";

export type DomainEventFanoutInput = {
  type: string;
  organizationId: string;
  projectId?: string;
  projectPublicId?: string;
  actorId: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
  topic?: string;
};

function publicProjectId(internalId: string): string {
  return `prj_${internalId.replaceAll("-", "")}`;
}

export async function insertDomainEventAndBroadcast(
  tx: MetalDb,
  input: DomainEventFanoutInput,
): Promise<{ eventId: string; publicEvent: DurableEventEnvelope; deliveries: number }> {
  const [event] = await tx
    .insert(domainEvents)
    .values({
      type: input.type,
      organizationId: input.organizationId,
      projectId: input.projectId,
      actorId: input.actorId,
      payload: input.data,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    })
    .returning();
  if (!event) {
    throw new Error("failed to persist domain event");
  }
  const projectPublicId =
    input.projectPublicId ?? (event.projectId ? publicProjectId(event.projectId) : undefined);
  const publicEvent = toPublicEvent({
    cursor: serializeCursor(event.cursor),
    eventId: event.eventId,
    type: event.type,
    organizationId: event.organizationId,
    projectId: projectPublicId,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
  await sendRealtimeBroadcast(tx, {
    topic:
      input.topic ??
      (projectPublicId ? projectTopic(projectPublicId) : organizationTopic(event.organizationId)),
    event: publicEvent.type,
    payload: publicEvent,
  });
  const deliveries = await enqueueWebhookDeliveries(tx, {
    organizationId: event.organizationId,
    eventId: event.eventId,
    publicEvent,
  });
  return { eventId: event.eventId, publicEvent, deliveries };
}

export async function enqueueWebhookDeliveries(
  tx: MetalDb,
  input: {
    organizationId: string;
    eventId: string;
    publicEvent: DurableEventEnvelope;
  },
): Promise<number> {
  const endpoints = await tx
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      name: webhookEndpoints.name,
      eventTypes: webhookEndpoints.eventTypes,
      enabled: webhookEndpoints.enabled,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, input.organizationId),
        eq(webhookEndpoints.enabled, true),
        isNull(webhookEndpoints.disabledAt),
        isNull(webhookEndpoints.deletedAt),
      ),
    );
  let created = 0;
  for (const endpoint of endpoints) {
    if (
      !matchesWebhookEndpoint(
        { enabled: endpoint.enabled, eventTypes: endpoint.eventTypes ?? [] },
        input.publicEvent.type,
      )
    ) {
      continue;
    }
    const [delivery] = await tx
      .insert(webhookDeliveries)
      .values({
        endpointId: endpoint.id,
        organizationId: input.organizationId,
        eventId: input.eventId,
        eventType: input.publicEvent.type,
        event: input.publicEvent as unknown as Record<string, unknown>,
        endpointUrl: endpoint.url,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });
    if (!delivery) {
      continue;
    }
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "webhook.deliver",
        dedupeKey: webhookDedupeKey(endpoint.id, input.eventId),
        payload: { job_type: "webhook.deliver", delivery_id: delivery.id },
      })
      .onConflictDoNothing();
    created += 1;
  }
  return created;
}

export async function enqueueWebhookDeliveryJob(tx: MetalDb, deliveryId: string): Promise<void> {
  await tx
    .insert(outboxJobs)
    .values({
      jobType: "webhook.deliver",
      dedupeKey: webhookDeliveryDedupeKey(deliveryId),
      payload: { job_type: "webhook.deliver", delivery_id: deliveryId },
    })
    .onConflictDoNothing();
}
