import { and, eq, sql } from "drizzle-orm";
import {
  buildWebhookSignatureHeaders,
  postPinnedWebhook,
  resolveValidatedWebhookTarget,
  type DnsResolver,
  type PinnedWebhookResponse,
} from "@openmetal/events/webhooks-node";
import {
  isRetryableWebhookStatus,
  matchesWebhookEndpoint,
  parseWebhookRetryAfterMs,
  webhookRetryDelayMs,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_BASE_BACKOFF_MS,
  WEBHOOK_MAX_STORED_RESPONSE_BYTES,
  type WebhookUrlPolicy,
} from "@openmetal/events";
import { createLogger, redactString } from "@openmetal/logger";
import { outboxJobs, webhookDeliveries, webhookEndpoints, type MetalDb } from "@openmetal/db";

const logger = createLogger({ service: "worker" });

export type WebhookAttemptResult = {
  httpStatus?: number;
  retryable: boolean;
  retryAfterMs?: number;
  error?: string;
  latencyMs: number;
  responseSnippet?: string;
};

export type WebhookPost = (input: {
  endpointUrl: string;
  validatedIp: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<PinnedWebhookResponse>;

export function webhookUrlPolicyForEnvironment(environment: string): WebhookUrlPolicy {
  if (environment === "production") {
    return { allowHttp: false, allowPrivateNetwork: false };
  }
  return { allowHttp: true, allowPrivateNetwork: true };
}

function snippetFor(body: Buffer, truncated: boolean): string | undefined {
  if (body.byteLength === 0) return undefined;
  const text = redactString(body.toString("utf8").slice(0, WEBHOOK_MAX_STORED_RESPONSE_BYTES));
  return truncated ? `${text} (response truncated)` : text || undefined;
}

export async function attemptWebhookDelivery(input: {
  endpointUrl: string;
  secret: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  rawBody: string;
  policy: WebhookUrlPolicy;
  resolver?: DnsResolver;
  postImpl?: WebhookPost;
}): Promise<WebhookAttemptResult> {
  const startedAt = Date.now();
  let validatedIp: string;
  try {
    const target = await resolveValidatedWebhookTarget(
      input.endpointUrl,
      input.policy,
      input.resolver,
    );
    const first = target.addresses[0];
    if (!first) {
      throw new Error("webhook url hostname could not be resolved");
    }
    validatedIp = first;
  } catch (error) {
    return {
      retryable: false,
      error: error instanceof Error ? error.message : "webhook url rejected",
      latencyMs: Date.now() - startedAt,
    };
  }
  const headers = buildWebhookSignatureHeaders({
    secret: input.secret,
    deliveryId: input.deliveryId,
    eventId: input.eventId,
    eventType: input.eventType,
    rawBody: input.rawBody,
  });
  const post = input.postImpl ?? postPinnedWebhook;
  let response: PinnedWebhookResponse;
  try {
    response = await post({
      endpointUrl: input.endpointUrl,
      validatedIp,
      headers,
      body: input.rawBody,
      timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
    });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof Error && /timed out/.test(error.message)) {
      return { retryable: true, error: "webhook delivery timed out", latencyMs };
    }
    return {
      retryable: true,
      error: redactString(error instanceof Error ? error.message : "webhook delivery failed").slice(
        0,
        500,
      ),
      latencyMs,
    };
  }
  const latencyMs = Date.now() - startedAt;
  const truncated = response.headers.get("x-metal-response-truncated") === "true";
  const responseSnippet = snippetFor(response.body, truncated);
  if (response.status >= 300 && response.status <= 399) {
    return {
      httpStatus: response.status,
      retryable: false,
      error: "webhook endpoint redirected the delivery; redirects are not followed",
      latencyMs,
      responseSnippet,
    };
  }
  if (response.status >= 200 && response.status < 300) {
    return { httpStatus: response.status, retryable: false, latencyMs };
  }
  const retryAfterMs = parseWebhookRetryAfterMs(response.headers.get("retry-after"));
  if (isRetryableWebhookStatus(response.status)) {
    return {
      httpStatus: response.status,
      retryable: true,
      retryAfterMs,
      error: `webhook endpoint returned ${response.status}${truncated ? " (response truncated)" : ""}`,
      latencyMs,
      responseSnippet,
    };
  }
  return {
    httpStatus: response.status,
    retryable: false,
    error: `webhook endpoint rejected the delivery with ${response.status}`,
    latencyMs,
    responseSnippet,
  };
}

export type WebhookDeliveryDisposition =
  | { kind: "missing" }
  | { kind: "succeeded"; deliveryId: string }
  | { kind: "retry"; deliveryId: string; availableAt: Date }
  | { kind: "failed"; deliveryId: string };

async function readWebhookSecret(
  tx: MetalDb,
  secretId: string | null,
): Promise<string | undefined> {
  if (!secretId) return undefined;
  const rows = (await tx.execute(sql`
    select decrypted_secret as "decryptedSecret"
    from vault.decrypted_secrets
    where id = ${secretId}
    limit 1
  `)) as unknown as Array<{ decryptedSecret: string }>;
  return rows[0]?.decryptedSecret;
}

export async function deliverWebhookOnce(
  db: MetalDb,
  deliveryId: string,
  input: {
    policy: WebhookUrlPolicy;
    maxAttempts?: number;
    baseBackoffMs?: number;
    resolver?: DnsResolver;
    postImpl?: WebhookPost;
  },
): Promise<WebhookDeliveryDisposition> {
  const maxAttempts = input.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
  const baseBackoffMs = input.baseBackoffMs ?? WEBHOOK_BASE_BACKOFF_MS;
  const row = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, deliveryId))
    .then((rows) => rows[0]);
  if (!row) {
    return { kind: "missing" };
  }
  const { delivery, endpoint } = row;
  if (delivery.status === "succeeded") {
    return { kind: "succeeded", deliveryId };
  }
  const endpointGone = endpoint.deletedAt || endpoint.disabledAt;
  if ((endpointGone || !endpoint.enabled) && !delivery.isTest) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        lastError: "webhook endpoint is disabled",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { kind: "failed", deliveryId };
  }
  if (
    !delivery.isTest &&
    !matchesWebhookEndpoint(
      { enabled: endpoint.enabled, eventTypes: endpoint.eventTypes ?? [] },
      delivery.eventType,
    )
  ) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        lastError: "webhook endpoint is not subscribed to this event type",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { kind: "failed", deliveryId };
  }
  const secret = await readWebhookSecret(db, endpoint.secretId);
  if (!secret) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        lastError: "webhook signing secret is unavailable",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { kind: "failed", deliveryId };
  }
  const attemptCount = delivery.attemptCount + 1;
  await db
    .update(webhookDeliveries)
    .set({ status: "delivering", attemptCount, updatedAt: new Date() })
    .where(eq(webhookDeliveries.id, delivery.id));
  const rawBody = JSON.stringify(delivery.event);
  const attempt = await attemptWebhookDelivery({
    endpointUrl: delivery.endpointUrl,
    secret,
    deliveryId: delivery.id,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    rawBody,
    policy: input.policy,
    resolver: input.resolver,
    postImpl: input.postImpl,
  });
  const child = logger.child({
    endpoint_id: endpoint.id,
    delivery_id: delivery.id,
    event_type: delivery.eventType,
    attempt: attemptCount,
  });
  const now = new Date();
  if (
    !attempt.retryable &&
    attempt.httpStatus !== undefined &&
    attempt.httpStatus >= 200 &&
    attempt.httpStatus < 300
  ) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "succeeded",
        lastHttpStatus: attempt.httpStatus,
        lastError: null,
        lastLatencyMs: attempt.latencyMs,
        responseSnippet: null,
        nextAttemptAt: null,
        deliveredAt: now,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    await db
      .update(webhookEndpoints)
      .set({ lastDeliveryAt: now, lastDeliveryStatus: "succeeded", updatedAt: now })
      .where(eq(webhookEndpoints.id, endpoint.id));
    child.info(
      { http_status: attempt.httpStatus, latency_ms: attempt.latencyMs },
      "webhook delivery succeeded",
    );
    return { kind: "succeeded", deliveryId };
  }
  if (attempt.retryable && attemptCount < maxAttempts) {
    const delayMs = webhookRetryDelayMs(attemptCount, baseBackoffMs, attempt.retryAfterMs);
    const availableAt = new Date(Date.now() + delayMs);
    await db
      .update(webhookDeliveries)
      .set({
        status: "retrying",
        lastHttpStatus: attempt.httpStatus ?? null,
        lastError: (attempt.error ?? "webhook delivery failed").slice(0, 500),
        lastLatencyMs: attempt.latencyMs,
        responseSnippet:
          attempt.responseSnippet?.slice(0, WEBHOOK_MAX_STORED_RESPONSE_BYTES) ?? null,
        nextAttemptAt: availableAt,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    await db
      .update(webhookEndpoints)
      .set({ lastDeliveryAt: now, lastDeliveryStatus: "retrying", updatedAt: now })
      .where(eq(webhookEndpoints.id, endpoint.id));
    child.warn(
      {
        http_status: attempt.httpStatus ?? null,
        latency_ms: attempt.latencyMs,
        next_attempt_at: availableAt.toISOString(),
        err: attempt.error,
      },
      "webhook delivery will retry",
    );
    return { kind: "retry", deliveryId, availableAt };
  }
  await db
    .update(webhookDeliveries)
    .set({
      status: "failed",
      lastHttpStatus: attempt.httpStatus ?? null,
      lastError: (attempt.error ?? "webhook delivery failed").slice(0, 500),
      lastLatencyMs: attempt.latencyMs,
      responseSnippet: attempt.responseSnippet?.slice(0, WEBHOOK_MAX_STORED_RESPONSE_BYTES) ?? null,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, delivery.id));
  await db
    .update(webhookEndpoints)
    .set({ lastDeliveryAt: now, lastDeliveryStatus: "failed", updatedAt: now })
    .where(eq(webhookEndpoints.id, endpoint.id));
  child.warn(
    { http_status: attempt.httpStatus ?? null, latency_ms: attempt.latencyMs, err: attempt.error },
    "webhook delivery failed terminally",
  );
  return { kind: "failed", deliveryId };
}

export async function settleWebhookJob(
  db: MetalDb,
  job: { id: string },
  workerId: string,
  leaseToken: string,
  disposition: WebhookDeliveryDisposition,
): Promise<void> {
  const owned = and(
    eq(outboxJobs.id, job.id),
    eq(outboxJobs.status, "leased"),
    eq(outboxJobs.leaseOwner, workerId),
    eq(outboxJobs.leaseToken, leaseToken),
  );
  if (disposition.kind === "retry") {
    await db
      .update(outboxJobs)
      .set({
        status: "pending",
        availableAt: disposition.availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseToken: null,
        updatedAt: new Date(),
        lastError: null,
      })
      .where(owned);
    return;
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
    .where(owned);
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
