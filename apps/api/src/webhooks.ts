import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  enqueueWebhookDeliveryJob,
  webhookDeliveries,
  webhookEndpoints,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import { assertWebhookUrlAllowed } from "@openmetal/events/webhooks-node";
import { EventTypeValues, type WebhookUrlPolicy } from "@openmetal/events";
import type {
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  WebhookEndpoint,
} from "@openmetal/contracts";
import { ApiError } from "./errors.js";
import { requireMembership } from "./services.js";

export function webhookUrlPolicyForEnvironment(environment: string): WebhookUrlPolicy {
  if (environment === "production") {
    return { allowHttp: false, allowPrivateNetwork: false };
  }
  return { allowHttp: true, allowPrivateNetwork: true };
}

function generateWebhookSecret(): { secret: string; prefix: string } {
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 14) };
}

function serializeEndpoint(row: typeof webhookEndpoints.$inferSelect): WebhookEndpoint {
  return {
    id: row.id,
    organization_id: row.organizationId,
    name: row.name,
    url: row.url,
    event_types: row.eventTypes ?? [],
    enabled: row.enabled,
    secret_prefix: row.secretPrefix,
    rotated_at: row.rotatedAt?.toISOString() ?? null,
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    last_delivery_status: row.lastDeliveryStatus,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    disabled_at: row.disabledAt?.toISOString() ?? null,
  };
}

function serializeDelivery(row: typeof webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: row.id,
    endpoint_id: row.endpointId,
    event_id: row.eventId,
    event_type: row.eventType,
    status: row.status,
    attempt_count: row.attemptCount,
    next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
    last_http_status: row.lastHttpStatus,
    last_error: row.lastError,
    last_latency_ms: row.lastLatencyMs,
    is_test: row.isTest,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    delivered_at: row.deliveredAt?.toISOString() ?? null,
  };
}

async function requireEndpoint(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    endpointId: string;
    roles?: Array<"owner" | "admin" | "member">;
  },
) {
  await requireMembership(db, input.userId, input.organizationId, input.roles);
  const endpoint = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, input.endpointId),
        eq(webhookEndpoints.organizationId, input.organizationId),
        isNull(webhookEndpoints.deletedAt),
      ),
    )
    .then((rows) => rows[0]);
  if (!endpoint) {
    throw new ApiError(404, "not_found", "webhook endpoint not found");
  }
  return endpoint;
}

function validateEventTypes(eventTypes: string[]): void {
  const catalog = new Set<string>(EventTypeValues);
  const unknown = eventTypes.filter((type) => !catalog.has(type));
  if (unknown.length > 0) {
    throw new ApiError(
      422,
      "validation_error",
      `unknown webhook event types: ${unknown.join(", ")}`,
    );
  }
  if (new Set(eventTypes).size !== eventTypes.length) {
    throw new ApiError(422, "validation_error", "duplicate webhook event types");
  }
}

async function createVaultSecret(tx: MetalDb, secret: string, name: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select vault.create_secret(
      ${secret},
      ${name},
      ${"Metal outbound webhook signing secret"}
    ) as id
  `)) as unknown as Array<{ id: string }>;
  const secretId = rows[0]?.id;
  if (!secretId) {
    throw new ApiError(500, "internal_error", "failed to encrypt webhook secret");
  }
  return secretId;
}

export async function listWebhookEndpoints(
  db: MetalDb,
  input: { userId: string; organizationId: string },
) {
  await requireMembership(db, input.userId, input.organizationId);
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, input.organizationId),
        isNull(webhookEndpoints.deletedAt),
      ),
    )
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map(serializeEndpoint);
}

export async function createWebhookEndpoint(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    body: CreateWebhookEndpointRequest;
    urlPolicy: WebhookUrlPolicy;
  },
) {
  validateEventTypes(input.body.event_types);
  try {
    await assertWebhookUrlAllowed(input.body.url, input.urlPolicy);
  } catch (error) {
    throw new ApiError(
      422,
      "validation_error",
      error instanceof Error ? error.message : "invalid webhook url",
    );
  }
  return withTransaction(db, async (tx) => {
    await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
    const { secret, prefix } = generateWebhookSecret();
    const secretName = `metal:webhook:${input.organizationId}:${crypto.randomUUID()}`;
    const secretId = await createVaultSecret(tx, secret, secretName);
    const [endpoint] = await tx
      .insert(webhookEndpoints)
      .values({
        organizationId: input.organizationId,
        name: input.body.name,
        url: input.body.url,
        eventTypes: [...input.body.event_types],
        enabled: input.body.enabled,
        secretId,
        secretPrefix: prefix,
        createdBy: input.userId,
      })
      .returning();
    if (!endpoint) {
      throw new ApiError(500, "internal_error", "failed to create webhook endpoint");
    }
    return { endpoint: serializeEndpoint(endpoint), secret };
  });
}

export async function getWebhookEndpoint(
  db: MetalDb,
  input: { userId: string; organizationId: string; endpointId: string },
) {
  const endpoint = await requireEndpoint(db, input);
  return serializeEndpoint(endpoint);
}

export async function updateWebhookEndpoint(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    endpointId: string;
    body: UpdateWebhookEndpointRequest;
    urlPolicy: WebhookUrlPolicy;
  },
) {
  if (input.body.event_types) {
    validateEventTypes(input.body.event_types);
  }
  if (input.body.url) {
    try {
      await assertWebhookUrlAllowed(input.body.url, input.urlPolicy);
    } catch (error) {
      throw new ApiError(
        422,
        "validation_error",
        error instanceof Error ? error.message : "invalid webhook url",
      );
    }
  }
  return withTransaction(db, async (tx) => {
    const existing = await requireEndpoint(tx, {
      userId: input.userId,
      organizationId: input.organizationId,
      endpointId: input.endpointId,
      roles: ["owner", "admin"],
    });
    const [endpoint] = await tx
      .update(webhookEndpoints)
      .set({
        ...(input.body.name !== undefined ? { name: input.body.name } : {}),
        ...(input.body.url !== undefined ? { url: input.body.url } : {}),
        ...(input.body.event_types !== undefined
          ? { eventTypes: [...input.body.event_types] }
          : {}),
        ...(input.body.enabled !== undefined
          ? {
              enabled: input.body.enabled,
              disabledAt: input.body.enabled ? null : (existing.disabledAt ?? new Date()),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(webhookEndpoints.id, existing.id))
      .returning();
    if (!endpoint) {
      throw new ApiError(404, "not_found", "webhook endpoint not found");
    }
    return serializeEndpoint(endpoint);
  });
}

export async function deleteWebhookEndpoint(
  db: MetalDb,
  input: { userId: string; organizationId: string; endpointId: string },
) {
  return withTransaction(db, async (tx) => {
    const existing = await requireEndpoint(tx, {
      userId: input.userId,
      organizationId: input.organizationId,
      endpointId: input.endpointId,
      roles: ["owner", "admin"],
    });
    const now = new Date();
    await tx
      .update(webhookEndpoints)
      .set({ enabled: false, disabledAt: now, deletedAt: now, updatedAt: now })
      .where(eq(webhookEndpoints.id, existing.id));
    await tx.execute(sql`delete from vault.secrets where id = ${existing.secretId}`);
    return { id: existing.id, deleted: true as const };
  });
}

export async function rotateWebhookSecret(
  db: MetalDb,
  input: { userId: string; organizationId: string; endpointId: string },
) {
  return withTransaction(db, async (tx) => {
    const existing = await requireEndpoint(tx, {
      userId: input.userId,
      organizationId: input.organizationId,
      endpointId: input.endpointId,
      roles: ["owner", "admin"],
    });
    const { secret, prefix } = generateWebhookSecret();
    await tx.execute(sql`select vault.update_secret(${existing.secretId}, ${secret})`);
    const [endpoint] = await tx
      .update(webhookEndpoints)
      .set({
        secretPrefix: prefix,
        rotatedAt: new Date(),
        rotatedBy: input.userId,
        updatedAt: new Date(),
      })
      .where(eq(webhookEndpoints.id, existing.id))
      .returning();
    if (!endpoint) {
      throw new ApiError(404, "not_found", "webhook endpoint not found");
    }
    return { endpoint: serializeEndpoint(endpoint), secret };
  });
}

export async function testWebhookEndpoint(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    endpointId: string;
    urlPolicy: WebhookUrlPolicy;
  },
) {
  return withTransaction(db, async (tx) => {
    const existing = await requireEndpoint(tx, {
      userId: input.userId,
      organizationId: input.organizationId,
      endpointId: input.endpointId,
      roles: ["owner", "admin"],
    });
    try {
      await assertWebhookUrlAllowed(existing.url, input.urlPolicy);
    } catch (error) {
      throw new ApiError(
        422,
        "validation_error",
        error instanceof Error ? error.message : "invalid webhook url",
      );
    }
    const eventId = crypto.randomUUID();
    const testEvent = {
      cursor: "test",
      event_id: eventId,
      type: "webhook.test",
      organization_id: input.organizationId,
      occurred_at: new Date().toISOString(),
      data: {
        endpoint_id: existing.id,
        endpoint_name: existing.name,
        message: "This is a Metal webhook connectivity test. No state changed.",
      },
    };
    const [delivery] = await tx
      .insert(webhookDeliveries)
      .values({
        endpointId: existing.id,
        organizationId: input.organizationId,
        eventId,
        eventType: "webhook.test",
        event: testEvent,
        endpointUrl: existing.url,
        status: "pending",
        isTest: true,
      })
      .returning();
    if (!delivery) {
      throw new ApiError(500, "internal_error", "failed to enqueue webhook test");
    }
    await enqueueWebhookDeliveryJob(tx, delivery.id);
    return serializeDelivery(delivery);
  });
}

export async function listWebhookDeliveries(
  db: MetalDb,
  input: { userId: string; organizationId: string; endpointId?: string; limit: number },
) {
  await requireMembership(db, input.userId, input.organizationId);
  const conditions = [eq(webhookDeliveries.organizationId, input.organizationId)];
  if (input.endpointId) {
    conditions.push(eq(webhookDeliveries.endpointId, input.endpointId));
  }
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(input.limit);
  return rows.map(serializeDelivery);
}

export async function redeliverWebhookDelivery(
  db: MetalDb,
  input: { userId: string; organizationId: string; endpointId: string; deliveryId: string },
) {
  return withTransaction(db, async (tx) => {
    await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
    const delivery = await tx
      .select({ delivery: webhookDeliveries, endpointDeletedAt: webhookEndpoints.deletedAt })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.organizationId, input.organizationId),
          eq(webhookDeliveries.endpointId, input.endpointId),
        ),
      )
      .then((rows) => rows[0]);
    if (!delivery || delivery.endpointDeletedAt) {
      throw new ApiError(404, "not_found", "webhook delivery not found");
    }
    if (delivery.delivery.status === "pending" || delivery.delivery.status === "delivering") {
      throw new ApiError(409, "delivery_in_flight", "delivery is already queued for dispatch");
    }
    const [updated] = await tx
      .update(webhookDeliveries)
      .set({
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: null,
        lastHttpStatus: null,
        lastError: null,
        lastLatencyMs: null,
        responseSnippet: null,
        deliveredAt: null,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.delivery.id))
      .returning();
    if (!updated) {
      throw new ApiError(404, "not_found", "webhook delivery not found");
    }
    await tx.execute(sql`
      delete from metal.outbox_jobs
      where job_type = 'webhook.deliver'
        and payload->>'delivery_id' = ${delivery.delivery.id}
    `);
    await enqueueWebhookDeliveryJob(tx, updated.id);
    return serializeDelivery(updated);
  });
}
