import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import {
  isIpLiteral,
  isPrivateOrReservedIp,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_MAX_RESPONSE_BYTES,
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
  const { url } = await resolveValidatedWebhookTarget(rawUrl, policy, resolver);
  return url;
}

export type ValidatedWebhookTarget = {
  url: URL;
  addresses: string[];
};

export async function resolveValidatedWebhookTarget(
  rawUrl: string,
  policy: WebhookUrlPolicy,
  resolver: DnsResolver = defaultResolver,
): Promise<ValidatedWebhookTarget> {
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
    return { url: parsed, addresses: ["127.0.0.1"] };
  }
  if (isIpLiteral(hostname)) {
    if (!policy.allowPrivateNetwork && isPrivateOrReservedIp(hostname)) {
      throw new Error("webhook url must not target private or link-local addresses");
    }
    return { url: parsed, addresses: [hostname] };
  }
  if (hostname === "metadata.google.internal" || hostname.endsWith(".metadata.google.internal")) {
    throw new Error("webhook url must not target cloud metadata endpoints");
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await resolver.lookup(hostname);
  } catch {
    throw new Error("webhook url hostname could not be resolved");
  }
  if (resolved.length === 0) {
    throw new Error("webhook url hostname could not be resolved");
  }
  const addresses = resolved.map(({ address }) => address.toLowerCase());
  if (!policy.allowPrivateNetwork && addresses.some((address) => isPrivateOrReservedIp(address))) {
    throw new Error("webhook url must not target private or link-local addresses");
  }
  return { url: parsed, addresses };
}

export type PinnedWebhookRequest = {
  endpointUrl: string;
  validatedIp: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  timeoutMs?: number;
  policy?: WebhookUrlPolicy;
  tls?: { ca?: string | Buffer | Array<string | Buffer> };
};

export type PinnedWebhookResponse = {
  status: number;
  headers: Headers;
  body: Buffer;
};

function hostHeaderFor(url: URL): string {
  let host = url.hostname;
  if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`;
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port || defaultPort;
  return port === defaultPort ? host : `${host}:${port}`;
}

export function postPinnedWebhook(input: PinnedWebhookRequest): Promise<PinnedWebhookResponse> {
  const timeoutMs = input.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS;
  let parsed: URL;
  try {
    parsed = new URL(input.endpointUrl);
  } catch {
    return Promise.reject(new Error("webhook url must be an absolute http(s) URL"));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Promise.reject(new Error("webhook url must be an absolute http(s) URL"));
  }
  const peer = input.validatedIp.toLowerCase().trim();
  if (!isIpLiteral(peer)) {
    return Promise.reject(
      new Error("webhook delivery must target a validated IP address, never a hostname"),
    );
  }
  if (input.policy && !input.policy.allowPrivateNetwork && isPrivateOrReservedIp(peer)) {
    return Promise.reject(new Error("webhook url must not target private or link-local addresses"));
  }
  const body =
    typeof input.body === "string" ? Buffer.from(input.body, "utf8") : Buffer.from(input.body);
  const isTls = parsed.protocol === "https:";
  return new Promise<PinnedWebhookResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const requestFn = isTls ? httpsRequest : httpRequest;
    const request = requestFn(
      {
        hostname: peer,
        port: Number(parsed.port || (isTls ? "443" : "80")),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: { ...input.headers, host: hostHeaderFor(parsed) },
        servername: isTls ? parsed.hostname : undefined,
        lookup: ((
          hostname: string,
          _options: unknown,
          callback: (error: Error | null, address: string, family: number) => void,
        ) => {
          callback(null, peer, peer.includes(":") ? 6 : 4);
        }) as NonNullable<RequestOptions["lookup"]>,
        ...(input.tls?.ca ? { ca: input.tls.ca } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total <= WEBHOOK_MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
          } else {
            truncated = true;
          }
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const entry of Array.isArray(value) ? value : [value]) {
              headers.append(name, String(entry));
            }
          }
          if (truncated) {
            headers.set("x-metal-response-truncated", "true");
          }
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        response.on("error", (error) =>
          fail(error instanceof Error ? error : new Error(String(error))),
        );
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("webhook delivery timed out"));
    });
    request.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    request.setTimeout(timeoutMs);
    request.end(body);
  });
}
