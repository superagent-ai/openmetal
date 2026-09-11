import { describe, expect, it } from "vitest";
import {
  assertWebhookUrlAllowed,
  buildWebhookSignatureHeaders,
  isPrivateOrReservedIp,
  isRetryableWebhookStatus,
  matchesWebhookEndpoint,
  parseWebhookRetryAfterMs,
  verifyWebhookSignature,
  webhookDedupeKey,
  WEBHOOK_MAX_RETRY_AFTER_MS,
} from "../src/webhooks.js";
import { EventTypeValues } from "../src/event.js";

describe("webhook helpers", () => {
  it("exposes a unified public event catalog", () => {
    for (const type of [
      "organization.updated",
      "organization.deleted",
      "organization.provider_credentials.configured",
      "process.queued",
      "process.cancel_requested",
      "runtime_operation.completed",
      "endpoint.expired",
      "billing.credits_granted",
      "sandbox.attempt_started",
      "webhook.test",
    ]) {
      expect(EventTypeValues).toContain(type);
    }
    expect(new Set(EventTypeValues).size).toBe(EventTypeValues.length);
  });

  it("signs and verifies delivery payloads with timestamp tolerance", () => {
    const secret = "whsec_test_secret";
    const headers = buildWebhookSignatureHeaders({
      secret,
      deliveryId: "delivery-1",
      eventId: "event-1",
      eventType: "sandbox.ready",
      rawBody: JSON.stringify({ hello: "world" }),
      timestamp: "1700000000",
    });
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId: "delivery-1",
        rawBody: JSON.stringify({ hello: "world" }),
        signatureHeader: headers["metal-signature"]!,
        timestampHeader: headers["metal-signature-timestamp"],
        nowSeconds: 1700000100,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId: "delivery-1",
        rawBody: JSON.stringify({ hello: "tampered" }),
        signatureHeader: headers["metal-signature"]!,
        nowSeconds: 1700000100,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId: "delivery-1",
        rawBody: JSON.stringify({ hello: "world" }),
        signatureHeader: headers["metal-signature"]!,
        nowSeconds: 1700000000 + 60 * 60,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId: "other-delivery",
        rawBody: JSON.stringify({ hello: "world" }),
        signatureHeader: headers["metal-signature"]!,
        nowSeconds: 1700000100,
      }),
    ).toBe(false);
  });

  it("classifies retryable statuses and parses Retry-After", () => {
    expect(isRetryableWebhookStatus(408)).toBe(true);
    expect(isRetryableWebhookStatus(429)).toBe(true);
    expect(isRetryableWebhookStatus(500)).toBe(true);
    expect(isRetryableWebhookStatus(503)).toBe(true);
    expect(isRetryableWebhookStatus(200)).toBe(false);
    expect(isRetryableWebhookStatus(400)).toBe(false);
    expect(isRetryableWebhookStatus(404)).toBe(false);
    expect(parseWebhookRetryAfterMs("30")).toBe(30_000);
    expect(parseWebhookRetryAfterMs("999999")).toBe(WEBHOOK_MAX_RETRY_AFTER_MS);
    expect(parseWebhookRetryAfterMs("not-a-date")).toBeUndefined();
    expect(parseWebhookRetryAfterMs(undefined)).toBeUndefined();
  });

  it("matches endpoints by enabled state and event filter", () => {
    expect(matchesWebhookEndpoint({ enabled: false, eventTypes: [] }, "sandbox.ready")).toBe(false);
    expect(matchesWebhookEndpoint({ enabled: true, eventTypes: [] }, "sandbox.ready")).toBe(true);
    expect(
      matchesWebhookEndpoint({ enabled: true, eventTypes: ["sandbox.ready"] }, "sandbox.failed"),
    ).toBe(false);
    expect(
      matchesWebhookEndpoint({ enabled: true, eventTypes: ["sandbox.ready"] }, "sandbox.ready"),
    ).toBe(true);
  });

  it("builds stable dedupe keys", () => {
    expect(webhookDedupeKey("endpoint", "event")).toBe("webhook:endpoint:event");
  });

  it("flags private and reserved IPs", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.0.1",
      "169.254.169.254",
      "::1",
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
  });

  it("rejects unsafe webhook URLs", async () => {
    const policy = { allowHttp: false, allowPrivateNetwork: false };
    const resolver = { lookup: async () => [{ address: "93.184.216.34" }] };
    await expect(
      assertWebhookUrlAllowed("http://example.com/hook", policy, resolver),
    ).rejects.toThrow(/https/);
    await expect(
      assertWebhookUrlAllowed("https://user:pass@example.com/hook", policy, resolver),
    ).rejects.toThrow(/credentials/);
    await expect(
      assertWebhookUrlAllowed("https://127.0.0.1/hook", policy, resolver),
    ).rejects.toThrow(/private/);
    await expect(
      assertWebhookUrlAllowed("https://169.254.169.254/latest", policy, resolver),
    ).rejects.toThrow(/private/);
    await expect(
      assertWebhookUrlAllowed("https://internal.example/hook", policy, {
        lookup: async () => [{ address: "10.0.0.5" }],
      }),
    ).rejects.toThrow(/private/);
    await expect(
      assertWebhookUrlAllowed("https://unresolvable.example/hook", policy, {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/resolved/);
    const parsed = await assertWebhookUrlAllowed("https://example.com/hook", policy, resolver);
    expect(parsed.hostname).toBe("example.com");
  });
});
