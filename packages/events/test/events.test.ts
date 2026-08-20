import { describe, expect, it } from "vitest";
import {
  detectCursorGap,
  isDuplicateDelivery,
  organizationTopic,
  parseCursor,
  parseTopic,
  projectTopic,
  serializeCursor,
  TopicError,
  validateOutboxPayload,
} from "../src/index.js";

describe("events", () => {
  it("constructs and parses validated topics", () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    expect(organizationTopic(organizationId)).toBe(`organization:${organizationId}`);
    expect(projectTopic(projectId)).toBe(`project:${projectId}`);
    expect(parseTopic(`project:${projectId}`)).toEqual({ kind: "project", id: projectId });
  });

  it("rejects free-form topic input", () => {
    expect(() => projectTopic("project:all")).toThrow(TopicError);
    expect(() => parseTopic("project:all")).toThrow(TopicError);
    expect(() => parseTopic("user-supplied")).toThrow(TopicError);
  });

  it("round-trips opaque cursors", () => {
    const cursor = serializeCursor(42n);
    expect(parseCursor(cursor)).toBe(42n);
  });

  it("detects sequence gaps", () => {
    expect(detectCursorGap(10n, 12n)).toBe(true);
    expect(detectCursorGap(10n, 11n)).toBe(false);
  });

  it("validates outbox payloads", () => {
    expect(() => validateOutboxPayload({ job_type: "other" })).toThrow();
  });

  it("deduplicates deliveries by event id and cursor", () => {
    const seen = new Set<string>();
    expect(isDuplicateDelivery(seen, "e1", "c1")).toBe(false);
    expect(isDuplicateDelivery(seen, "e1", "c1")).toBe(true);
    expect(isDuplicateDelivery(seen, "e1", "c2")).toBe(true);
  });
});
