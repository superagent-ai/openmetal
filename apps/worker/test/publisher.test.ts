import { describe, expect, it } from "vitest";
import { serializeCursor } from "@openmetal/events";
import { parseJobPayload } from "../src/publisher.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function payload(topic: string, eventProjectId = projectId) {
  return {
    job_type: "realtime.broadcast",
    topic,
    event: {
      cursor: serializeCursor(1n),
      event_id: "33333333-3333-4333-8333-333333333333",
      type: "project.created",
      organization_id: organizationId,
      project_id: eventProjectId,
      occurred_at: "2026-08-20T12:00:00.000Z",
      data: {},
    },
  };
}

describe("worker publisher payload", () => {
  it("accepts a matching project topic", () => {
    expect(() => parseJobPayload(payload(`project:${projectId}`))).not.toThrow();
  });

  it("rejects a topic that does not match the event project", () => {
    expect(() => parseJobPayload(payload("project:44444444-4444-4444-8444-444444444444"))).toThrow(
      /does not match/,
    );
  });
});
