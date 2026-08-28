import {
  formatMicrousdUsd,
  getOrganizationUsageAnalytics,
  type OrganizationUsageAnalytics,
} from "@openmetal/billing";
import {
  OrganizationUsageQuerySchema,
  OrganizationUsageSchema,
  type OrganizationUsage,
  type UsageCostAmount,
} from "@openmetal/contracts";
import type { MetalDb } from "@openmetal/db";
import { ApiError } from "./errors.js";
import { requireMembership } from "./services.js";

function cost(amount: bigint): UsageCostAmount {
  return {
    microusd: amount.toString(),
    usd: formatMicrousdUsd(amount),
  };
}

function percentChange(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const basisPoints = ((current - previous) * 10_000n) / (previous < 0n ? -previous : previous);
  return Number(basisPoints) / 100;
}

function sharePercent(value: bigint, total: bigint): number {
  if (total <= 0n || value <= 0n) return 0;
  return Math.min(100, Number((value * 10_000n) / total) / 100);
}

export function serializeOrganizationUsage(
  analytics: OrganizationUsageAnalytics,
): OrganizationUsage {
  const total = analytics.summary.totalCostMicrousd;
  const knownCost = analytics.coverage.items
    .filter((item) => item.provenance !== "unknown")
    .reduce((sum, item) => sum + (item.costMicrousd > 0n ? item.costMicrousd : 0n), 0n);
  const availablePercent =
    total > 0n
      ? Math.min(100, Number((knownCost * 10_000n) / total) / 100)
      : analytics.coverage.unavailableSandboxCount === 0
        ? 100
        : 0;

  const response = {
    organization_id: analytics.organizationId,
    period: {
      from: analytics.period.from.toISOString(),
      through: analytics.period.through.toISOString(),
      comparison_from: analytics.period.comparisonFrom.toISOString(),
      comparison_through: analytics.period.comparisonThrough.toISOString(),
      timezone: "UTC" as const,
    },
    summary: {
      total_cost: {
        current: cost(analytics.summary.totalCostMicrousd),
        previous: cost(analytics.summary.previousTotalCostMicrousd),
        change_percent: percentChange(
          analytics.summary.totalCostMicrousd,
          analytics.summary.previousTotalCostMicrousd,
        ),
      },
      managed_cost: {
        current: cost(analytics.summary.managedCostMicrousd),
        previous: cost(analytics.summary.previousManagedCostMicrousd),
        change_percent: percentChange(
          analytics.summary.managedCostMicrousd,
          analytics.summary.previousManagedCostMicrousd,
        ),
      },
      byok_cost: {
        current: cost(analytics.summary.byokCostMicrousd),
        previous: cost(analytics.summary.previousByokCostMicrousd),
        change_percent: percentChange(
          analytics.summary.byokCostMicrousd,
          analytics.summary.previousByokCostMicrousd,
        ),
      },
      projected_month_end: cost(analytics.summary.projectedMonthEndMicrousd),
    },
    coverage: {
      available_percent: availablePercent,
      items: analytics.coverage.items.map((item) => ({
        provenance: item.provenance,
        confidence: item.confidence,
        cost: cost(item.costMicrousd),
        percent: sharePercent(item.costMicrousd, total),
      })),
      unavailable_sandbox_count: analytics.coverage.unavailableSandboxCount,
    },
    daily: analytics.daily.map((day) => ({
      date: day.date,
      total_cost: cost(day.totalCostMicrousd),
      managed_cost: cost(day.managedCostMicrousd),
      byok_cost: cost(day.byokCostMicrousd),
      providers: day.providers.map((item) => ({
        key: item.key,
        label: item.label,
        cost: cost(item.costMicrousd),
      })),
      projects: day.projects.map((item) => ({
        key: item.key,
        label: item.label,
        cost: cost(item.costMicrousd),
      })),
    })),
    by_provider: analytics.byProvider.map((item) => ({
      provider: item.provider,
      cost: cost(item.costMicrousd),
      previous_cost: cost(item.previousCostMicrousd),
      change_percent: percentChange(item.costMicrousd, item.previousCostMicrousd),
      share_percent: sharePercent(item.costMicrousd, total),
      managed_cost: cost(item.managedCostMicrousd),
      byok_cost: cost(item.byokCostMicrousd),
      reported_percent: sharePercent(item.reportedCostMicrousd, item.costMicrousd),
    })),
    by_project: analytics.byProject.map((item) => ({
      project_id: item.projectId,
      project_name: item.projectName,
      project_slug: item.projectSlug,
      cost: cost(item.costMicrousd),
      previous_cost: cost(item.previousCostMicrousd),
      change_percent: percentChange(item.costMicrousd, item.previousCostMicrousd),
      share_percent: sharePercent(item.costMicrousd, total),
      managed_cost: cost(item.managedCostMicrousd),
      byok_cost: cost(item.byokCostMicrousd),
    })),
    top_sandboxes: analytics.topSandboxes.map((item) => ({
      sandbox_id: item.sandboxId,
      project_id: item.projectId,
      project_name: item.projectName,
      project_slug: item.projectSlug,
      provider: item.provider,
      billing_mode: item.billingMode,
      status: item.status,
      cost: cost(item.costMicrousd),
      previous_cost: cost(item.previousCostMicrousd),
      change_percent: percentChange(item.costMicrousd, item.previousCostMicrousd),
      provenance: item.provenance,
      confidence: item.confidence,
      cost_source: item.costSource,
    })),
    activity: analytics.activity.map((item) => ({
      id: item.id,
      measured_through: item.measuredThrough.toISOString(),
      sandbox_id: item.sandboxId,
      project_id: item.projectId,
      project_name: item.projectName,
      project_slug: item.projectSlug,
      provider: item.provider,
      billing_mode: item.billingMode,
      status: item.status,
      cost_delta: cost(item.costDeltaMicrousd),
      cumulative_cost: cost(item.cumulativeCostMicrousd),
      provenance: item.provenance,
      confidence: item.confidence,
      cost_source: item.costSource,
      rate_card_version: item.rateCardVersion,
    })),
    generated_at: analytics.generatedAt.toISOString(),
  };
  return OrganizationUsageSchema.parse(response);
}

export async function readOrganizationUsage(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    query: unknown;
  },
) {
  await requireMembership(db, input.userId, input.organizationId);
  const parsed = OrganizationUsageQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    throw new ApiError(422, "validation_error", "invalid usage query");
  }
  try {
    const analytics = await getOrganizationUsageAnalytics(db, input.organizationId, {
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      through: parsed.data.through ? new Date(parsed.data.through) : undefined,
      projectId: parsed.data.project_id,
      provider: parsed.data.provider,
      billingMode: parsed.data.billing_mode,
      status: parsed.data.status,
      costProvenance: parsed.data.cost_provenance,
      sandboxId: parsed.data.sandbox_id,
      limit: parsed.data.limit,
    });
    return serializeOrganizationUsage(analytics);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(422, "validation_error", error.message);
    }
    throw error;
  }
}
