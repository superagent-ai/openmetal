import { describe, expect, it } from "vitest";
import type { OrganizationUsageAnalytics } from "@openmetal/billing";
import { serializeOrganizationUsage } from "../src/usage.js";

function analytics(
  overrides: Partial<OrganizationUsageAnalytics["summary"]> = {},
): OrganizationUsageAnalytics {
  return {
    organizationId: "95d46af2-e438-47e1-9da6-14c98c449dd5",
    period: {
      from: new Date("2026-08-01T00:00:00.000Z"),
      through: new Date("2026-08-08T00:00:00.000Z"),
      comparisonFrom: new Date("2026-07-25T00:00:00.000Z"),
      comparisonThrough: new Date("2026-08-01T00:00:00.000Z"),
    },
    summary: {
      totalCostMicrousd: 8_000_000n,
      previousTotalCostMicrousd: 4_000_000n,
      managedCostMicrousd: 6_000_000n,
      previousManagedCostMicrousd: 3_000_000n,
      byokCostMicrousd: 2_000_000n,
      previousByokCostMicrousd: 1_000_000n,
      projectedMonthEndMicrousd: 31_000_000n,
      ...overrides,
    },
    coverage: {
      unavailableSandboxCount: 1,
      items: [
        {
          provenance: "provider_reported",
          confidence: "high",
          costMicrousd: 6_000_000n,
        },
        {
          provenance: "estimated_rate_card",
          confidence: "medium",
          costMicrousd: 2_000_000n,
        },
      ],
    },
    daily: [
      {
        date: "2026-08-01",
        totalCostMicrousd: 8_000_000n,
        managedCostMicrousd: 6_000_000n,
        byokCostMicrousd: 2_000_000n,
        providers: [{ key: "e2b", label: "e2b", costMicrousd: 8_000_000n }],
        projects: [
          {
            key: "prj_abc123",
            label: "Agent runtime",
            costMicrousd: 8_000_000n,
          },
        ],
      },
    ],
    byProvider: [
      {
        provider: "e2b",
        costMicrousd: 8_000_000n,
        previousCostMicrousd: 4_000_000n,
        managedCostMicrousd: 6_000_000n,
        byokCostMicrousd: 2_000_000n,
        reportedCostMicrousd: 6_000_000n,
      },
    ],
    byProject: [
      {
        projectId: "prj_abc123",
        projectName: "Agent runtime",
        projectSlug: "agent-runtime",
        costMicrousd: 8_000_000n,
        previousCostMicrousd: 4_000_000n,
        managedCostMicrousd: 6_000_000n,
        byokCostMicrousd: 2_000_000n,
      },
    ],
    topSandboxes: [
      {
        sandboxId: "sbx_abc123",
        projectId: "prj_abc123",
        projectName: "Agent runtime",
        projectSlug: "agent-runtime",
        provider: "e2b",
        billingMode: "managed",
        status: "ready",
        costMicrousd: 8_000_000n,
        previousCostMicrousd: 4_000_000n,
        provenance: "provider_metered",
        confidence: "medium",
        costSource: "e2b-lifecycle-events",
      },
    ],
    activity: [],
    generatedAt: new Date("2026-08-08T00:00:01.000Z"),
  };
}

describe("organization usage serialization", () => {
  it("keeps managed and BYOK cost separate", () => {
    const result = serializeOrganizationUsage(analytics());
    expect(result.summary.total_cost.current.usd).toBe("8.00");
    expect(result.summary.managed_cost.current.usd).toBe("6.00");
    expect(result.summary.byok_cost.current.usd).toBe("2.00");
    expect(result.summary.total_cost.change_percent).toBe(100);
    expect(result.by_provider[0]?.reported_percent).toBe(75);
    expect(result.coverage.available_percent).toBe(100);
  });

  it("uses a null change when there is no comparison cost", () => {
    const result = serializeOrganizationUsage(
      analytics({
        previousTotalCostMicrousd: 0n,
        previousManagedCostMicrousd: 0n,
        previousByokCostMicrousd: 0n,
      }),
    );
    expect(result.summary.total_cost.change_percent).toBeNull();
  });
});
