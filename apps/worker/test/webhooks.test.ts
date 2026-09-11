import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@openmetal/events/webhooks-node";
import type { PinnedWebhookResponse } from "@openmetal/events/webhooks-node";
import { attemptWebhookDelivery, runWithConcurrency } from "../src/webhooks.js";

const policy = { allowHttp: true, allowPrivateNetwork: true };
const secret = "whsec_unit_test_secret";

type ScriptedPost = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  error?: Error;
};

function createScriptedPost(script: ScriptedPost[]) {
  const requests: Array<{
    endpointUrl: string;
    validatedIp: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const queue = [...script];
  const postImpl = async (input: {
    endpointUrl: string;
    validatedIp: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<PinnedWebhookResponse> => {
    requests.push({ ...input });
    const next = queue.shift();
    if (!next) throw new Error("unexpected scripted post request");
    if (next.error) throw next.error;
    const headers = new Headers({ "content-type": "application/json" });
    for (const [name, value] of Object.entries(next.headers ?? {})) {
      headers.set(name, value);
    }
    return { status: next.status ?? 200, headers, body: Buffer.from(next.body ?? "") };
  };
  return { postImpl, requests };
}

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
    const { postImpl, requests } = createScriptedPost([{ status: 200, body: `{"ok":true}` }]);
    const result = await attemptWebhookDelivery({
      ...inputFor({ postImpl }),
      policy: { allowHttp: false, allowPrivateNetwork: false },
    });
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(200);
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.endpointUrl).toBe("https://93.184.216.34/metal-events");
    expect(sent.validatedIp).toBe("93.184.216.34");
    expect(sent.headers["metal-delivery-id"]).toBe("delivery-1");
    expect(sent.headers["metal-event-id"]).toBe("event-1");
    expect(sent.headers["metal-event-type"]).toBe("sandbox.ready");
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId: "delivery-1",
        rawBody: JSON.stringify({ event_id: "event-1" }),
        signatureHeader: sent.headers["metal-signature"]!,
        timestampHeader: sent.headers["metal-signature-timestamp"],
      }),
    ).toBe(true);
  });

  it("retries 429 and 5xx and honors Retry-After", async () => {
    const { postImpl } = createScriptedPost([
      { status: 429, body: "{}", headers: { "retry-after": "120" } },
    ]);
    const retryable = await attemptWebhookDelivery(inputFor({ postImpl }));
    expect(retryable.retryable).toBe(true);
    expect(retryable.httpStatus).toBe(429);
    expect(retryable.retryAfterMs).toBe(120_000);

    const terminal = createScriptedPost([{ status: 404, body: "{}" }]);
    const rejected = await attemptWebhookDelivery(inputFor({ postImpl: terminal.postImpl }));
    expect(rejected.retryable).toBe(false);
    expect(rejected.httpStatus).toBe(404);
  });

  it("treats redirects as terminal and transport failures as retryable", async () => {
    const redirect = createScriptedPost([{ status: 307, body: "" }]);
    const redirected = await attemptWebhookDelivery(inputFor({ postImpl: redirect.postImpl }));
    expect(redirected.retryable).toBe(false);
    expect(redirected.error).toMatch(/redirect/i);

    const network = createScriptedPost([{ error: new Error("socket hang up") }]);
    const failed = await attemptWebhookDelivery(inputFor({ postImpl: network.postImpl }));
    expect(failed.retryable).toBe(true);
    expect(failed.error).toMatch(/socket hang up/);

    const timeout = createScriptedPost([{ error: new Error("webhook delivery timed out") }]);
    const timedOut = await attemptWebhookDelivery(inputFor({ postImpl: timeout.postImpl }));
    expect(timedOut.retryable).toBe(true);
    expect(timedOut.error).toBe("webhook delivery timed out");
  });

  it("revalidates the destination URL on every attempt", async () => {
    const { postImpl, requests } = createScriptedPost([{ status: 200, body: "{}" }]);
    const blocked = await attemptWebhookDelivery(
      inputFor({
        endpointUrl: "https://169.254.169.254/latest",
        postImpl,
        policy: { allowHttp: false, allowPrivateNetwork: false },
      }),
    );
    expect(blocked.retryable).toBe(false);
    expect(blocked.error).toMatch(/private/);
    expect(requests).toHaveLength(0);
  });

  it("pins the connection to the validated IP with a single lookup", async () => {
    let lookups = 0;
    const resolver = {
      lookup: async (hostname: string) => {
        lookups += 1;
        expect(hostname).toBe("rebind.example");
        // DNS rebinding: the record flips to link-local right after validation.
        return [{ address: lookups === 1 ? "93.184.216.34" : "169.254.169.254" }];
      },
    };
    const { postImpl, requests } = createScriptedPost([{ status: 200, body: "{}" }]);
    const result = await attemptWebhookDelivery(
      inputFor({
        endpointUrl: "https://rebind.example/metal-events",
        postImpl,
        resolver,
        policy: { allowHttp: false, allowPrivateNetwork: false },
      }),
    );
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(200);
    expect(lookups).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.validatedIp).toBe("93.184.216.34");
  });

  it("rejects when the hostname resolves to a private address", async () => {
    const { postImpl, requests } = createScriptedPost([{ status: 200, body: "{}" }]);
    const blocked = await attemptWebhookDelivery(
      inputFor({
        endpointUrl: "https://internal.example/metal-events",
        postImpl,
        resolver: { lookup: async () => [{ address: "10.0.0.5" }] },
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
