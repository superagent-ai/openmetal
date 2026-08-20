import { parseTopic, validateOutboxPayload } from "@openmetal/events";

export type BroadcastPublisher = {
  publish: (topic: string, eventName: string, payload: unknown) => Promise<void>;
};

export function createRealtimePublisher(input: {
  supabaseUrl: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}): BroadcastPublisher {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async publish(topic, eventName, payload) {
      parseTopic(topic);
      const url = new URL(
        `/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(eventName)}`,
        input.supabaseUrl,
      );
      url.searchParams.set("private", "true");
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          apikey: input.secretKey,
          authorization: `Bearer ${input.secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`realtime publish failed (${response.status}): ${text.slice(0, 300)}`);
      }
    },
  };
}

export function parseJobPayload(payload: unknown) {
  return validateOutboxPayload(payload);
}
