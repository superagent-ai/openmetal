import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export const WEBHOOK_SIGNATURE_HEADER = "metal-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "metal-signature-timestamp";
export const WEBHOOK_DELIVERY_ID_HEADER = "metal-delivery-id";
export const WEBHOOK_EVENT_ID_HEADER = "metal-event-id";
export const WEBHOOK_EVENT_TYPE_HEADER = "metal-event-type";

export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 1_048_576;
export const WEBHOOK_MAX_STORED_RESPONSE_BYTES = 4_096;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_BASE_BACKOFF_MS = 5_000;
export const WEBHOOK_MAX_BACKOFF_MS = 15 * 60_000;
export const WEBHOOK_MAX_RETRY_AFTER_MS = 10 * 60_000;

export function webhookDedupeKey(endpointId: string, eventId: string): string {
  return `webhook:${endpointId}:${eventId}`;
}

export function webhookDeliveryDedupeKey(deliveryId: string): string {
  return `webhook:delivery:${deliveryId}`;
}

export function matchesWebhookEndpoint(
  endpoint: { enabled: boolean; eventTypes: string[] },
  eventType: string,
): boolean {
  if (!endpoint.enabled) return false;
  if (endpoint.eventTypes.length === 0) return true;
  return endpoint.eventTypes.includes(eventType);
}

export function signWebhookPayload(input: {
  secret: string;
  timestamp: string;
  deliveryId: string;
  rawBody: string | Uint8Array;
}): string {
  const body = typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody);
  return createHmac("sha256", input.secret)
    .update(input.timestamp, "utf8")
    .update(".", "utf8")
    .update(input.deliveryId, "utf8")
    .update(".", "utf8")
    .update(body)
    .digest("hex");
}

export function buildWebhookSignatureHeaders(input: {
  secret: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  rawBody: string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    [WEBHOOK_DELIVERY_ID_HEADER]: input.deliveryId,
    [WEBHOOK_EVENT_ID_HEADER]: input.eventId,
    [WEBHOOK_EVENT_TYPE_HEADER]: input.eventType,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: `t=${timestamp},v1=${signWebhookPayload({
      secret: input.secret,
      timestamp,
      deliveryId: input.deliveryId,
      rawBody: input.rawBody,
    })}`,
  };
}

export function verifyWebhookSignature(input: {
  secret: string;
  deliveryId: string;
  rawBody: string | Uint8Array;
  signatureHeader: string;
  timestampHeader?: string;
  nowSeconds?: number;
}): boolean {
  const match = /(?:^|,)t=(\d+),v1=([0-9a-fA-F]+)(?:,|$)/.exec(input.signatureHeader);
  if (!match) return false;
  const timestamp = match[1]!;
  if (input.timestampHeader && input.timestampHeader !== timestamp) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = signWebhookPayload({
    secret: input.secret,
    timestamp,
    deliveryId: input.deliveryId,
    rawBody: input.rawBody,
  });
  const received = match[2]!;
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}

export function isRetryableWebhookStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

export function parseWebhookRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, WEBHOOK_MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - nowMs, 0), WEBHOOK_MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

export function webhookRetryDelayMs(
  attempt: number,
  baseMs = WEBHOOK_BASE_BACKOFF_MS,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), WEBHOOK_MAX_BACKOFF_MS);
  const jittered = Math.round(exponential * (0.5 + Math.random()));
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, jittered), WEBHOOK_MAX_BACKOFF_MS);
  }
  return jittered;
}

export type WebhookUrlPolicy = {
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
};

export function productionWebhookUrlPolicy(): WebhookUrlPolicy {
  return { allowHttp: false, allowPrivateNetwork: false };
}

export function isPrivateOrReservedIp(address: string): boolean {
  if (isIP(address) === 0) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized === "0.0.0.0") return true;
  if (normalized.includes(":")) {
    if (
      normalized === "::ffff:127.0.0.1" ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      normalized.startsWith("::ffff:172.")
    ) {
      return true;
    }
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("fec0") ||
      normalized.startsWith("ff")
    ) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(normalized.slice("::ffff:".length));
    }
    if (normalized === "64:ff9b::" || normalized.startsWith("2001:db8") || normalized === "100::") {
      return true;
    }
    return false;
  }
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 0 || a === 100 || a === 192 || a === 198 || a === 203 || a === 224 || a! >= 240) {
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
    if (a === 192 && (b === 0 || b === 88 || b === 94)) return true;
    if (a === 198 && b !== undefined && b >= 18 && b <= 19) return true;
    if (a !== undefined && a >= 224) return true;
    if (a === 0 || (a === 203 && b === 0) || (a === 192 && b === 0)) return true;
  }
  return false;
}

export type DnsResolver = {
  lookup(hostname: string): Promise<Array<{ address: string }>>;
};

const defaultResolver: DnsResolver = {
  async lookup(hostname: string) {
    return dns.lookup(hostname, { all: true });
  },
};

export async function assertWebhookUrlAllowed(
  rawUrl: string,
  policy: WebhookUrlPolicy,
  resolver: DnsResolver = defaultResolver,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("webhook url must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("webhook url must be an absolute http(s) URL");
  }
  if (parsed.protocol === "http:" && !policy.allowHttp) {
    throw new Error("webhook url must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("webhook url must not embed credentials");
  }
  if (!parsed.hostname) {
    throw new Error("webhook url must include a hostname");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (!policy.allowPrivateNetwork) {
      throw new Error("webhook url must not target private or link-local addresses");
    }
    return parsed;
  }
  if (isIP(hostname) !== 0) {
    if (!policy.allowPrivateNetwork && isPrivateOrReservedIp(hostname)) {
      throw new Error("webhook url must not target private or link-local addresses");
    }
    return parsed;
  }
  if (hostname === "metadata.google.internal" || hostname.endsWith(".metadata.google.internal")) {
    throw new Error("webhook url must not target cloud metadata endpoints");
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver.lookup(hostname);
  } catch {
    throw new Error("webhook url hostname could not be resolved");
  }
  if (addresses.length === 0) {
    throw new Error("webhook url hostname could not be resolved");
  }
  if (
    !policy.allowPrivateNetwork &&
    addresses.some(({ address }) => isPrivateOrReservedIp(address))
  ) {
    throw new Error("webhook url must not target private or link-local addresses");
  }
  return parsed;
}
