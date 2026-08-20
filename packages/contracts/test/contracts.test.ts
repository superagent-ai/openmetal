import { describe, expect, it } from "vitest";
import {
  CreateOrganizationRequestSchema,
  CreateProjectRequestSchema,
  DurableEventEnvelopeSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ListEventsQuerySchema,
  OpaqueIdSchema,
  ReadinessResponseSchema,
} from "../src/index.js";

describe("contract parsing", () => {
  it("accepts a valid health payload", () => {
    expect(HealthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects an unknown health status", () => {
    expect(() => HealthResponseSchema.parse({ status: "fine" })).toThrow();
  });

  it("accepts a ready payload", () => {
    expect(
      ReadinessResponseSchema.parse({
        status: "ready",
        checks: { database: "ok" },
      }),
    ).toMatchObject({ status: "ready" });
  });

  it("rejects a missing error request_id", () => {
    expect(() =>
      ErrorEnvelopeSchema.parse({
        code: "unauthenticated",
        message: "missing token",
      }),
    ).toThrow();
  });

  it("accepts the stable error envelope", () => {
    expect(
      ErrorEnvelopeSchema.parse({
        code: "forbidden",
        message: "not a member",
        request_id: "req_1",
        details: { organization_id: "x" },
      }),
    ).toMatchObject({ code: "forbidden" });
  });

  it("rejects an invalid organization slug", () => {
    expect(() =>
      CreateOrganizationRequestSchema.parse({ name: "Acme", slug: "Not Valid" }),
    ).toThrow();
  });

  it("accepts a valid organization create body", () => {
    expect(CreateOrganizationRequestSchema.parse({ name: "Northwind", slug: "northwind" })).toEqual(
      {
        name: "Northwind",
        slug: "northwind",
      },
    );
  });

  it("rejects a project create body with an empty name", () => {
    expect(() => CreateProjectRequestSchema.parse({ name: "  ", slug: "alpha" })).toThrow();
  });

  it("rejects a malformed opaque id", () => {
    expect(() => OpaqueIdSchema.parse("proj_123")).toThrow();
  });

  it("accepts a durable event envelope", () => {
    const parsed = DurableEventEnvelopeSchema.parse({
      cursor: "Y3Vyc29y",
      event_id: "11111111-1111-4111-8111-111111111111",
      type: "project.created",
      organization_id: "22222222-2222-4222-8222-222222222222",
      project_id: "33333333-3333-4333-8333-333333333333",
      occurred_at: "2026-08-20T08:00:00.000Z",
      data: { name: "alpha" },
    });
    expect(parsed.type).toBe("project.created");
  });

  it("rejects an event page query without project_id", () => {
    expect(() => ListEventsQuerySchema.parse({ after: "abc" })).toThrow();
  });
});
