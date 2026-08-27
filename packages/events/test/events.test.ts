import { describe, expect, it } from "vitest";
import {
  detectCursorGap,
  EventTypeValueSchema,
  isDuplicateDelivery,
  organizationTopic,
  parseCursor,
  parseTopic,
  projectTopic,
  serializeCursor,
  TopicError,
  toPublicEvent,
  validateOutboxPayload,
} from "../src/index.js";

describe("events", () => {
  it("constructs and parses validated topics", () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const projectId = "prj_22222222222242228222222222222222";
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
    expect(
      validateOutboxPayload({
        job_type: "billing.auto_topup.evaluate",
        organization_id: "11111111-1111-4111-8111-111111111111",
        reason: "usage_charge",
      }),
    ).toMatchObject({ job_type: "billing.auto_topup.evaluate" });
    expect(
      validateOutboxPayload({
        job_type: "billing.spend_limit.enforce",
        organization_id: "11111111-1111-4111-8111-111111111111",
        reason: "insufficient_credits",
      }),
    ).toMatchObject({ job_type: "billing.spend_limit.enforce" });
    expect(
      validateOutboxPayload({
        job_type: "process.execute",
        process_id: "33333333-3333-4333-8333-333333333333",
      }),
    ).toMatchObject({ job_type: "process.execute" });
    expect(
      validateOutboxPayload({
        job_type: "filesystem.write",
        runtime_operation_id: "44444444-4444-4444-8444-444444444444",
      }),
    ).toMatchObject({ job_type: "filesystem.write" });
    expect(
      validateOutboxPayload({
        job_type: "endpoint.revoke",
        endpoint_id: "55555555-5555-4555-8555-555555555555",
      }),
    ).toMatchObject({ job_type: "endpoint.revoke" });
    expect(() =>
      validateOutboxPayload({
        job_type: "process.cancel",
        process_id: "proc_public-id-is-not-internal",
      }),
    ).toThrow();
  });

  it("publishes stable runtime lifecycle event names", () => {
    expect(EventTypeValueSchema.parse("process.cancel_requested")).toBe("process.cancel_requested");
    expect(EventTypeValueSchema.parse("runtime_operation.completed")).toBe(
      "runtime_operation.completed",
    );
    expect(EventTypeValueSchema.parse("endpoint.expired")).toBe("endpoint.expired");
  });

  it("deduplicates deliveries by event id and cursor", () => {
    const seen = new Set<string>();
    expect(isDuplicateDelivery(seen, "e1", "c1")).toBe(false);
    expect(isDuplicateDelivery(seen, "e1", "c1")).toBe(true);
    expect(isDuplicateDelivery(seen, "e1", "c2")).toBe(true);
  });

  it("redacts secrets before an event becomes public or enters the outbox", () => {
    const event = toPublicEvent({
      cursor: serializeCursor(1n),
      eventId: "11111111-1111-4111-8111-111111111111",
      type: "project.created",
      organizationId: "22222222-2222-4222-8222-222222222222",
      projectId: "prj_33333333333343338333333333333333",
      occurredAt: "2026-08-20T12:00:00.000Z",
      data: {
        authorization: "Bearer secret-token",
        cookie: "session=secret",
        database_url: "postgresql://user:password@localhost/database",
        signed_url: "https://storage.example/file?token=secret",
        nested: { api_key: "sk-abcdefghijklmnopqrstuvwxyz123456" },
        safe: "project-created",
      },
    });

    expect(event.data).toMatchObject({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      database_url: "[REDACTED]",
      signed_url: "[REDACTED]",
      nested: { api_key: "[REDACTED]" },
      safe: "project-created",
    });
    expect(() =>
      validateOutboxPayload({
        job_type: "realtime.broadcast",
        topic: `project:${event.project_id}`,
        event,
      }),
    ).not.toThrow();
  });
});
