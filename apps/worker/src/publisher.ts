import { parseTopic, RealtimeBroadcastJobPayloadSchema } from "@openmetal/events";

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
        throw new Error(`realtime publish failed (${response.status})`);
      }
    },
  };
}

export function parseJobPayload(payload: unknown) {
  const parsed = RealtimeBroadcastJobPayloadSchema.parse(payload);
  const topic = parseTopic(parsed.topic);
  if (
    topic.kind === "project" &&
    parsed.event.project_id?.replace(/^prj_/, "").toLowerCase() !==
      topic.id.replace(/^prj_/, "").replaceAll("-", "").toLowerCase()
  ) {
    throw new Error("outbox project topic does not match event");
  }
  if (topic.kind === "organization" && parsed.event.organization_id !== topic.id) {
    throw new Error("outbox organization topic does not match event");
  }
  return parsed;
}
