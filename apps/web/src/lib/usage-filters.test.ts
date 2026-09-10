import { describe, expect, it } from "vitest";
import { parseUsageFilters, usageQueryForFilters } from "./usage-filters";

describe("usage filters", () => {
  it("uses safe defaults for unknown query values", () => {
    expect(
      parseUsageFilters({
        range: "forever",
        billing_mode: "invoice",
        provider: "unknown",
        project_id: "not-a-project",
      }),
    ).toEqual({
      range: "24h",
      billingMode: "all",
      provider: undefined,
      projectId: undefined,
      status: undefined,
      costProvenance: undefined,
    });
  });

  it("accepts provider, project, range, and billing mode filters", () => {
    expect(
      parseUsageFilters({
        range: "7d",
        billing_mode: "byok",
        provider: "freestyle",
        project_id: "prj_abc123",
        status: "stopped",
        cost_provenance: "provider_reported",
      }),
    ).toEqual({
      range: "7d",
      billingMode: "byok",
      provider: "freestyle",
      projectId: "prj_abc123",
      status: "stopped",
      costProvenance: "provider_reported",
    });
  });

  it("builds a seven day UTC API range", () => {
    const query = usageQueryForFilters(
      {
        range: "7d",
        billingMode: "managed",
        provider: "e2b",
      },
      new Date("2026-08-27T15:45:00.000Z"),
    );
    expect(query).toEqual({
      from: "2026-08-20T15:45:00.000Z",
      through: "2026-08-27T15:45:00.000Z",
      project_id: undefined,
      provider: "e2b",
      billing_mode: "managed",
      status: undefined,
      cost_provenance: undefined,
      limit: 100,
    });
  });

  it("starts current month ranges at the UTC month boundary", () => {
    const query = usageQueryForFilters(
      { range: "this_month", billingMode: "all" },
      new Date("2026-08-27T15:45:00.000Z"),
    );
    expect(query.from).toBe("2026-08-01T00:00:00.000Z");
  });
});
