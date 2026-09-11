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

export function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(":")) return true;
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

export function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.toLowerCase().trim();
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
  const parts = normalized.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)
  ) {
    return true;
  }
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 0 || a === 100 || a === 192 || a === 198 || a === 203 || a === 224 || a >= 240) {
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && (b === 0 || b === 88 || b === 94)) return true;
    if (a === 198 && b >= 18 && b <= 19) return true;
    if (a >= 224) return true;
    if (a === 0 || (a === 203 && b === 0) || (a === 192 && b === 0)) return true;
  }
  return false;
}
