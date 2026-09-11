import { describe, expect, it } from "vitest";
import { createScriptedFetch } from "@openmetal/testkit";
import { verifyWebhookSignature } from "@openmetal/events";
import { attemptWebhookDelivery, runWithConcurrency } from "../src/webhooks.js";

const policy = { allowHttp: true, allowPrivateNetwork: true };
const secret = "whsec_unit_test_secret";

function inputFor(overrides: Record<string, unknown> = {}) {
  return {
    endpointUrl: "https://93.184.216.34/metal-events",
    secret,
    deliveryId: "delivery-1",
    eventId: "event-1",
    eventType: "sandbox.ready",
    rawBody: JSON.stringify({ event_id: "event-1" }),
    policy,
    ...overrides,
  };
}

describe("webhook delivery attempts", () => {
  it("signs request bytes and succeeds on 2xx", async () => {
    const { fetchImpl, requests } = createScriptedFetch([{ status: 200, body: { ok: true } }]);
    const result = await attemptWebhookDelivery({
      ...inputFor({ fetchImpl }),
      policy: { allowHttp: false, allowPrivateNetwork: false },
    });
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(200);
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.url).toBe("https://93.184.216.34/metal-events");
    const headers = sent.init?.headers as Record<string, string>;
    expect(headers["metal-delivery-id"]).toBe("delivery-1");
    expect(headers["metal-event-id"]).toBe("event-1");
    expect(headers["metal-event-type"]).toBe("sandbox.ready");
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId: "delivery-1",
        rawBody: JSON.stringify({ event_id: "event-1" }),
        signatureHeader: headers["metal-signature"]!,
        timestampHeader: headers["metal-signature-timestamp"],
      }),
    ).toBe(true);
  });

  it("retries 429 and 5xx and honors Retry-After", async () => {
    const { fetchImpl } = createScriptedFetch([
      { status: 429, body: {}, headers: { "retry-after": "120" } },
    ]);
    const retryable = await attemptWebhookDelivery(inputFor({ fetchImpl }));
    expect(retryable.retryable).toBe(true);
    expect(retryable.httpStatus).toBe(429);
    expect(retryable.retryAfterMs).toBe(120_000);

    const terminal = createScriptedFetch([{ status: 404, body: {} }]);
    const rejected = await attemptWebhookDelivery(inputFor({ fetchImpl: terminal.fetchImpl }));
    expect(rejected.retryable).toBe(false);
    expect(rejected.httpStatus).toBe(404);
  });

  it("treats redirects as terminal and network failures as retryable", async () => {
    const redirect = createScriptedFetch([{ status: 307, body: {} }]);
    const redirected = await attemptWebhookDelivery(inputFor({ fetchImpl: redirect.fetchImpl }));
    expect(redirected.retryable).toBe(false);
    expect(redirected.error).toMatch(/redirect/i);

    const network = createScriptedFetch([{ error: new Error("socket hang up") }]);
    const failed = await attemptWebhookDelivery(inputFor({ fetchImpl: network.fetchImpl }));
    expect(failed.retryable).toBe(true);
    expect(failed.error).toMatch(/socket hang up/);
  });

  it("revalidates the destination URL on every attempt", async () => {
    const { fetchImpl, requests } = createScriptedFetch([{ status: 200, body: {} }]);
    const blocked = await attemptWebhookDelivery(
      inputFor({
        endpointUrl: "https://169.254.169.254/latest",
        fetchImpl,
        policy: { allowHttp: false, allowPrivateNetwork: false },
      }),
    );
    expect(blocked.retryable).toBe(false);
    expect(blocked.error).toMatch(/private/);
    expect(requests).toHaveLength(0);
  });

  it("bounds concurrency across deliveries", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 9 }, (_, index) => index);
    await runWithConcurrency(items, 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
