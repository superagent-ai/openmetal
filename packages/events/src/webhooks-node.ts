import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  isIpLiteral,
  isPrivateOrReservedIp,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type WebhookUrlPolicy,
} from "./webhooks.js";

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
    "metal-delivery-id": input.deliveryId,
    "metal-event-id": input.eventId,
    "metal-event-type": input.eventType,
    "metal-signature-timestamp": timestamp,
    "metal-signature": `t=${timestamp},v1=${signWebhookPayload({
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
  if (isIpLiteral(hostname)) {
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
