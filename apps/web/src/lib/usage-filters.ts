import type { OrganizationUsageQuery } from "@openmetal/sdk";

export const usageRanges = [
  "15m",
  "30m",
  "1h",
  "3h",
  "24h",
  "48h",
  "7d",
  "30d",
  "1y",
  "today",
  "yesterday",
  "this_week",
  "prev_week",
  "this_month",
  "prev_month",
  "this_year",
  "prev_year",
  "live",
] as const;
export type UsageRange = (typeof usageRanges)[number];

export const usageBillingModes = ["all", "managed", "byok"] as const;
export type UsageBillingModeFilter = (typeof usageBillingModes)[number];

const providers = [
  "blaxel",
  "cloudflare",
  "codesandbox",
  "daytona",
  "e2b",
  "freestyle",
  "modal",
  "northflank",
  "prime",
  "runloop",
  "vercel",
] as const;

export type UsageFilters = {
  range: UsageRange;
  projectId?: string;
  provider?: (typeof providers)[number];
  billingMode: UsageBillingModeFilter;
  status?: OrganizationUsageQuery["status"];
  costProvenance?: OrganizationUsageQuery["cost_provenance"];
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function includes<T extends string>(values: readonly T[], value: string | undefined): value is T {
  return value !== undefined && values.includes(value as T);
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function parseUsageFilters(
  query: Record<string, string | string[] | undefined>,
): UsageFilters {
  const rawRange = first(query.range);
  const rawBillingMode = first(query.billing_mode);
  const rawProvider = first(query.provider);
  const rawProjectId = first(query.project_id);
  const rawStatus = first(query.status);
  const rawCostProvenance = first(query.cost_provenance);
  const statuses = [
    "requested",
    "routing",
    "provisioning",
    "provision_unknown",
    "ready",
    "pausing",
    "paused",
    "resuming",
    "runtime_unknown",
    "stopping",
    "stopped",
    "failed",
    "cleanup_pending",
    "cleanup_failed",
  ] as const;
  const provenances = [
    "provider_reported",
    "provider_metered",
    "estimated_rate_card",
    "unknown",
  ] as const;
  return {
    range: includes(usageRanges, rawRange) ? rawRange : "24h",
    billingMode: includes(usageBillingModes, rawBillingMode) ? rawBillingMode : "all",
    provider: includes(providers, rawProvider) ? rawProvider : undefined,
    projectId: rawProjectId && /^prj_[A-Za-z0-9]+$/.test(rawProjectId) ? rawProjectId : undefined,
    status: includes(statuses, rawStatus) ? rawStatus : undefined,
    costProvenance: includes(provenances, rawCostProvenance) ? rawCostProvenance : undefined,
  };
}

function startOfUtcWeek(value: Date): Date {
  const day = startOfUtcDay(value);
  const weekday = day.getUTCDay() || 7;
  return new Date(day.getTime() - (weekday - 1) * 24 * 60 * 60 * 1_000);
}

export function usageQueryForFilters(
  filters: UsageFilters,
  now: Date = new Date(),
): OrganizationUsageQuery {
  const through = now;
  const today = startOfUtcDay(now);
  const hour = 60 * 60 * 1_000;
  const day = 24 * hour;
  let from = new Date(now.getTime() - day);
  let rangeThrough = through;
  if (filters.range === "15m") from = new Date(now.getTime() - 15 * 60 * 1_000);
  else if (filters.range === "30m") from = new Date(now.getTime() - 30 * 60 * 1_000);
  else if (filters.range === "1h") from = new Date(now.getTime() - hour);
  else if (filters.range === "3h") from = new Date(now.getTime() - 3 * hour);
  else if (filters.range === "48h") from = new Date(now.getTime() - 48 * hour);
  else if (filters.range === "7d") from = new Date(now.getTime() - 7 * day);
  else if (filters.range === "30d") from = new Date(now.getTime() - 30 * day);
  else if (filters.range === "1y") from = new Date(now.getTime() - 365 * day);
  else if (filters.range === "today") from = today;
  else if (filters.range === "yesterday") {
    from = new Date(today.getTime() - day);
    rangeThrough = today;
  } else if (filters.range === "this_week") from = startOfUtcWeek(now);
  else if (filters.range === "prev_week") {
    rangeThrough = startOfUtcWeek(now);
    from = new Date(rangeThrough.getTime() - 7 * day);
  } else if (filters.range === "this_month") {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (filters.range === "prev_month") {
    rangeThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  } else if (filters.range === "this_year") {
    from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  } else if (filters.range === "prev_year") {
    rangeThrough = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    from = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  } else if (filters.range === "live") {
    from = new Date(now.getTime() - 15 * 60 * 1_000);
  }
  return {
    from: from.toISOString(),
    through: rangeThrough.toISOString(),
    project_id: filters.projectId,
    provider: filters.provider,
    billing_mode: filters.billingMode,
    status: filters.status,
    cost_provenance: filters.costProvenance,
    limit: 100,
  };
}
