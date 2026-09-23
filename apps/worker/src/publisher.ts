import { sendRealtimeBroadcast, type MetalDb } from "@openmetal/db";
import { parseTopic, RealtimeBroadcastJobPayloadSchema } from "@openmetal/events";

export type BroadcastPublisher = {
  publish: (topic: string, eventName: string, payload: unknown) => Promise<void>;
};

export function createRealtimePublisher(db: MetalDb): BroadcastPublisher {
  return {
    publish: (topic, eventName, payload) =>
      sendRealtimeBroadcast(db, { topic, event: eventName, payload }),
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
