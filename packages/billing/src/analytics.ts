import { and, count, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { projects, providerCostSnapshots, sandboxes, type MetalDb } from "@openmetal/db";
import { toMicrousd } from "./money.js";

export type UsageCostProvenance =
  "provider_reported" | "provider_metered" | "estimated_rate_card" | "unknown";
export type UsageCostConfidence = "high" | "medium" | "low" | "unknown";
export type UsageBillingMode = "managed" | "byok";
type SandboxStatus = typeof sandboxes.$inferSelect.status;

export type OrganizationUsageAnalytics = {
  organizationId: string;
  period: {
    from: Date;
    through: Date;
    comparisonFrom: Date;
    comparisonThrough: Date;
  };
  summary: {
    totalCostMicrousd: bigint;
    previousTotalCostMicrousd: bigint;
    managedCostMicrousd: bigint;
    previousManagedCostMicrousd: bigint;
    byokCostMicrousd: bigint;
    previousByokCostMicrousd: bigint;
    projectedMonthEndMicrousd: bigint;
  };
  coverage: {
    unavailableSandboxCount: number;
    items: Array<{
      provenance: UsageCostProvenance;
      confidence: UsageCostConfidence;
      costMicrousd: bigint;
    }>;
  };
  daily: Array<{
    date: string;
    totalCostMicrousd: bigint;
    managedCostMicrousd: bigint;
    byokCostMicrousd: bigint;
    providers: Array<{ key: string; label: string; costMicrousd: bigint }>;
    projects: Array<{ key: string; label: string; costMicrousd: bigint }>;
  }>;
  byProvider: Array<{
    provider: string;
    costMicrousd: bigint;
    previousCostMicrousd: bigint;
    managedCostMicrousd: bigint;
    byokCostMicrousd: bigint;
    reportedCostMicrousd: bigint;
  }>;
  byProject: Array<{
    projectId: string;
    projectName: string;
    projectSlug: string;
    costMicrousd: bigint;
    previousCostMicrousd: bigint;
    managedCostMicrousd: bigint;
    byokCostMicrousd: bigint;
  }>;
  topSandboxes: Array<{
    sandboxId: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
    provider: string;
    billingMode: UsageBillingMode;
    status: string;
    costMicrousd: bigint;
    previousCostMicrousd: bigint;
    provenance: UsageCostProvenance;
    confidence: UsageCostConfidence;
    costSource: string | null;
  }>;
  activity: Array<{
    id: string;
    measuredThrough: Date;
    sandboxId: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
    provider: string;
    billingMode: UsageBillingMode;
    status: string;
    costDeltaMicrousd: bigint;
    cumulativeCostMicrousd: bigint;
    provenance: UsageCostProvenance;
    confidence: UsageCostConfidence;
    costSource: string | null;
    rateCardVersion: string | null;
  }>;
  generatedAt: Date;
};

type UsageQuery = {
  from?: Date;
  through?: Date;
  projectId?: string;
  provider?: string;
  billingMode?: "all" | UsageBillingMode;
  status?: SandboxStatus;
  costProvenance?: UsageCostProvenance;
  sandboxId?: string;
  limit?: number;
};

type AggregateRow = {
  date: string;
  sandboxId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  provider: string;
  billingMode: string;
  status: string;
  provenance: string;
  confidence: string;
  costSource: string | null;
  costMicrousd: bigint | string;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_MS = 366 * DAY_MS;

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addCost(map: Map<string, bigint>, key: string, cost: bigint) {
  map.set(key, (map.get(key) ?? 0n) + cost);
}

function inPeriod(value: string, from: Date, through: Date): boolean {
  const timestamp = new Date(`${value}T00:00:00.000Z`).getTime();
  return timestamp >= startOfUtcDay(from).getTime() && timestamp < through.getTime();
}

function provenance(value: string): UsageCostProvenance {
  if (
    value === "provider_reported" ||
    value === "provider_metered" ||
    value === "estimated_rate_card"
  ) {
    return value;
  }
  return "unknown";
}

function confidence(value: string): UsageCostConfidence {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "unknown";
}

function billingMode(value: string): UsageBillingMode {
  return value === "byok" ? "byok" : "managed";
}

function publicStatus(value: string): string {
  return value === "deleting" ? "stopping" : value === "deleted" ? "stopped" : value;
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function eachUtcDay(from: Date, through: Date): string[] {
  const days: string[] = [];
  for (
    let cursor = startOfUtcDay(from);
    cursor.getTime() < through.getTime();
    cursor = new Date(cursor.getTime() + DAY_MS)
  ) {
    days.push(utcDateKey(cursor));
  }
  return days;
}

export async function getOrganizationUsageAnalytics(
  db: MetalDb,
  organizationId: string,
  query: UsageQuery = {},
): Promise<OrganizationUsageAnalytics> {
  const generatedAt = new Date();
  const through = query.through ?? generatedAt;
  const from = query.from ?? new Date(startOfUtcDay(through).getTime() - 29 * DAY_MS);
  const durationMs = through.getTime() - from.getTime();
  if (durationMs <= 0 || durationMs > MAX_RANGE_MS) {
    throw new RangeError("usage range must be between 1 and 366 days");
  }
  const comparisonThrough = from;
  const comparisonFrom = new Date(from.getTime() - durationMs);
  const monthStart = new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), 1));
  const queryFrom = new Date(Math.min(comparisonFrom.getTime(), monthStart.getTime()));

  const filters = [
    eq(providerCostSnapshots.organizationId, organizationId),
    gte(providerCostSnapshots.measuredThrough, queryFrom),
    lt(providerCostSnapshots.measuredThrough, through),
  ];
  if (query.projectId) filters.push(eq(projects.publicId, query.projectId));
  if (query.provider) filters.push(eq(providerCostSnapshots.provider, query.provider));
  if (query.billingMode && query.billingMode !== "all") {
    filters.push(eq(providerCostSnapshots.billingMode, query.billingMode));
  }
  if (query.status) filters.push(eq(sandboxes.status, query.status));
  if (query.costProvenance) {
    filters.push(eq(providerCostSnapshots.costProvenance, query.costProvenance));
  }
  if (query.sandboxId) filters.push(eq(sandboxes.publicId, query.sandboxId));

  const rows = (await db
    .select({
      date: sql<string>`(${providerCostSnapshots.measuredThrough} at time zone 'UTC')::date::text`,
      sandboxId: sandboxes.publicId,
      projectId: projects.publicId,
      projectName: projects.name,
      projectSlug: projects.slug,
      provider: providerCostSnapshots.provider,
      billingMode: providerCostSnapshots.billingMode,
      status: sandboxes.status,
      provenance: providerCostSnapshots.costProvenance,
      confidence: providerCostSnapshots.costConfidence,
      costSource: providerCostSnapshots.costSource,
      costMicrousd: sql<string>`coalesce(sum(${providerCostSnapshots.costDeltaMicrousd}), 0)::bigint`,
    })
    .from(providerCostSnapshots)
    .innerJoin(sandboxes, eq(sandboxes.id, providerCostSnapshots.sandboxId))
    .innerJoin(projects, eq(projects.id, providerCostSnapshots.projectId))
    .where(and(...filters))
    .groupBy(
      sql`(${providerCostSnapshots.measuredThrough} at time zone 'UTC')::date`,
      sandboxes.publicId,
      projects.publicId,
      projects.name,
      projects.slug,
      providerCostSnapshots.provider,
      providerCostSnapshots.billingMode,
      sandboxes.status,
      providerCostSnapshots.costProvenance,
      providerCostSnapshots.costConfidence,
      providerCostSnapshots.costSource,
    )) as AggregateRow[];

  const unavailableFilters = [
    eq(sandboxes.organizationId, organizationId),
    lt(sandboxes.createdAt, through),
    or(isNull(sandboxes.deletedAt), gte(sandboxes.deletedAt, from)),
    isNull(sandboxes.providerCostMicrousd),
  ];
  if (query.projectId) unavailableFilters.push(eq(projects.publicId, query.projectId));
  if (query.provider) unavailableFilters.push(eq(sandboxes.provider, query.provider));
  if (query.billingMode && query.billingMode !== "all") {
    unavailableFilters.push(eq(sandboxes.billingMode, query.billingMode));
  }
  if (query.status) unavailableFilters.push(eq(sandboxes.status, query.status));
  if (query.sandboxId) unavailableFilters.push(eq(sandboxes.publicId, query.sandboxId));
  const [{ value: unavailableSandboxCount = 0 } = { value: 0 }] = query.costProvenance
    ? [{ value: 0 }]
    : await db
        .select({ value: count() })
        .from(sandboxes)
        .innerJoin(projects, eq(projects.id, sandboxes.projectId))
        .where(and(...unavailableFilters));

  const activityFilters = [
    eq(providerCostSnapshots.organizationId, organizationId),
    gte(providerCostSnapshots.measuredThrough, from),
    lt(providerCostSnapshots.measuredThrough, through),
  ];
  if (query.projectId) activityFilters.push(eq(projects.publicId, query.projectId));
  if (query.provider) activityFilters.push(eq(providerCostSnapshots.provider, query.provider));
  if (query.billingMode && query.billingMode !== "all") {
    activityFilters.push(eq(providerCostSnapshots.billingMode, query.billingMode));
  }
  if (query.status) activityFilters.push(eq(sandboxes.status, query.status));
  if (query.costProvenance) {
    activityFilters.push(eq(providerCostSnapshots.costProvenance, query.costProvenance));
  }
  if (query.sandboxId) activityFilters.push(eq(sandboxes.publicId, query.sandboxId));
  const activityRows = await db
    .select({
      id: providerCostSnapshots.id,
      measuredThrough: providerCostSnapshots.measuredThrough,
      sandboxId: sandboxes.publicId,
      projectId: projects.publicId,
      projectName: projects.name,
      projectSlug: projects.slug,
      provider: providerCostSnapshots.provider,
      billingMode: providerCostSnapshots.billingMode,
      status: sandboxes.status,
      costDeltaMicrousd: providerCostSnapshots.costDeltaMicrousd,
      cumulativeCostMicrousd: providerCostSnapshots.amountMicrousd,
      provenance: providerCostSnapshots.costProvenance,
      confidence: providerCostSnapshots.costConfidence,
      costSource: providerCostSnapshots.costSource,
      rateCardVersion: providerCostSnapshots.rateCardVersion,
    })
    .from(providerCostSnapshots)
    .innerJoin(sandboxes, eq(sandboxes.id, providerCostSnapshots.sandboxId))
    .innerJoin(projects, eq(projects.id, providerCostSnapshots.projectId))
    .where(and(...activityFilters))
    .orderBy(desc(providerCostSnapshots.measuredThrough), desc(providerCostSnapshots.capturedAt))
    .limit(query.limit ?? 100);

  const currentRows = rows.filter((row) => inPeriod(row.date, from, through));
  const previousRows = rows.filter((row) => inPeriod(row.date, comparisonFrom, comparisonThrough));
  const currentTotal = currentRows.reduce((total, row) => total + toMicrousd(row.costMicrousd), 0n);
  const previousTotal = previousRows.reduce(
    (total, row) => total + toMicrousd(row.costMicrousd),
    0n,
  );
  const currentManaged = currentRows
    .filter((row) => billingMode(row.billingMode) === "managed")
    .reduce((total, row) => total + toMicrousd(row.costMicrousd), 0n);
  const previousManaged = previousRows
    .filter((row) => billingMode(row.billingMode) === "managed")
    .reduce((total, row) => total + toMicrousd(row.costMicrousd), 0n);
  const currentByok = currentTotal - currentManaged;
  const previousByok = previousTotal - previousManaged;

  const monthRows = rows.filter((row) => inPeriod(row.date, monthStart, through));
  const monthCost = monthRows.reduce((total, row) => total + toMicrousd(row.costMicrousd), 0n);
  const monthEnd = new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth() + 1, 1));
  const elapsedMonthMs = Math.max(through.getTime() - monthStart.getTime(), DAY_MS);
  const projectedMonthEndMicrousd =
    (monthCost * BigInt(monthEnd.getTime() - monthStart.getTime())) / BigInt(elapsedMonthMs);

  const coverageMap = new Map<string, bigint>();
  for (const row of currentRows) {
    addCost(
      coverageMap,
      `${provenance(row.provenance)}:${confidence(row.confidence)}`,
      toMicrousd(row.costMicrousd),
    );
  }

  const providerCurrent = new Map<string, bigint>();
  const providerPrevious = new Map<string, bigint>();
  const providerManaged = new Map<string, bigint>();
  const providerByok = new Map<string, bigint>();
  const providerReported = new Map<string, bigint>();
  for (const row of currentRows) {
    const cost = toMicrousd(row.costMicrousd);
    addCost(providerCurrent, row.provider, cost);
    addCost(
      billingMode(row.billingMode) === "managed" ? providerManaged : providerByok,
      row.provider,
      cost,
    );
    if (provenance(row.provenance) === "provider_reported") {
      addCost(providerReported, row.provider, cost);
    }
  }
  for (const row of previousRows) {
    addCost(providerPrevious, row.provider, toMicrousd(row.costMicrousd));
  }

  const projectDetails = new Map<string, { projectName: string; projectSlug: string }>();
  const projectCurrent = new Map<string, bigint>();
  const projectPrevious = new Map<string, bigint>();
  const projectManaged = new Map<string, bigint>();
  const projectByok = new Map<string, bigint>();
  for (const row of currentRows) {
    const cost = toMicrousd(row.costMicrousd);
    projectDetails.set(row.projectId, {
      projectName: row.projectName,
      projectSlug: row.projectSlug,
    });
    addCost(projectCurrent, row.projectId, cost);
    addCost(
      billingMode(row.billingMode) === "managed" ? projectManaged : projectByok,
      row.projectId,
      cost,
    );
  }
  for (const row of previousRows) {
    projectDetails.set(row.projectId, {
      projectName: row.projectName,
      projectSlug: row.projectSlug,
    });
    addCost(projectPrevious, row.projectId, toMicrousd(row.costMicrousd));
  }

  const sandboxDetails = new Map<
    string,
    {
      projectId: string;
      projectName: string;
      projectSlug: string;
      provider: string;
      billingMode: UsageBillingMode;
      status: string;
      provenance: UsageCostProvenance;
      confidence: UsageCostConfidence;
      costSource: string | null;
      provenanceCost: bigint;
    }
  >();
  const sandboxCurrent = new Map<string, bigint>();
  const sandboxPrevious = new Map<string, bigint>();
  for (const row of currentRows) {
    const cost = toMicrousd(row.costMicrousd);
    addCost(sandboxCurrent, row.sandboxId, cost);
    const detail = sandboxDetails.get(row.sandboxId);
    if (!detail || (cost < 0n ? -cost : cost) > detail.provenanceCost) {
      sandboxDetails.set(row.sandboxId, {
        projectId: row.projectId,
        projectName: row.projectName,
        projectSlug: row.projectSlug,
        provider: row.provider,
        billingMode: billingMode(row.billingMode),
        status: row.status,
        provenance: provenance(row.provenance),
        confidence: confidence(row.confidence),
        costSource: row.costSource,
        provenanceCost: cost < 0n ? -cost : cost,
      });
    }
  }
  for (const row of previousRows) {
    addCost(sandboxPrevious, row.sandboxId, toMicrousd(row.costMicrousd));
  }

  const daily = eachUtcDay(from, through).map((date) => {
    const dayRows = currentRows.filter((row) => row.date === date);
    const providersForDay = new Map<string, bigint>();
    const projectsForDay = new Map<string, bigint>();
    let managedCostMicrousd = 0n;
    let byokCostMicrousd = 0n;
    for (const row of dayRows) {
      const cost = toMicrousd(row.costMicrousd);
      addCost(providersForDay, row.provider, cost);
      addCost(projectsForDay, row.projectId, cost);
      if (billingMode(row.billingMode) === "managed") managedCostMicrousd += cost;
      else byokCostMicrousd += cost;
    }
    return {
      date,
      totalCostMicrousd: managedCostMicrousd + byokCostMicrousd,
      managedCostMicrousd,
      byokCostMicrousd,
      providers: [...providersForDay.entries()]
        .map(([key, costMicrousd]) => ({ key, label: key, costMicrousd }))
        .sort((left, right) => Number(right.costMicrousd - left.costMicrousd)),
      projects: [...projectsForDay.entries()]
        .map(([key, costMicrousd]) => ({
          key,
          label: projectDetails.get(key)?.projectName ?? key,
          costMicrousd,
        }))
        .sort((left, right) => Number(right.costMicrousd - left.costMicrousd)),
    };
  });

  return {
    organizationId,
    period: { from, through, comparisonFrom, comparisonThrough },
    summary: {
      totalCostMicrousd: currentTotal,
      previousTotalCostMicrousd: previousTotal,
      managedCostMicrousd: currentManaged,
      previousManagedCostMicrousd: previousManaged,
      byokCostMicrousd: currentByok,
      previousByokCostMicrousd: previousByok,
      projectedMonthEndMicrousd,
    },
    coverage: {
      unavailableSandboxCount,
      items: [...coverageMap.entries()].map(([key, costMicrousd]) => {
        const [rawProvenance = "unknown", rawConfidence = "unknown"] = key.split(":");
        return {
          provenance: provenance(rawProvenance),
          confidence: confidence(rawConfidence),
          costMicrousd,
        };
      }),
    },
    daily,
    byProvider: [...providerCurrent.entries()]
      .map(([provider, costMicrousd]) => ({
        provider,
        costMicrousd,
        previousCostMicrousd: providerPrevious.get(provider) ?? 0n,
        managedCostMicrousd: providerManaged.get(provider) ?? 0n,
        byokCostMicrousd: providerByok.get(provider) ?? 0n,
        reportedCostMicrousd: providerReported.get(provider) ?? 0n,
      }))
      .sort((left, right) => Number(right.costMicrousd - left.costMicrousd)),
    byProject: [...projectCurrent.entries()]
      .map(([projectId, costMicrousd]) => {
        const detail = projectDetails.get(projectId)!;
        return {
          projectId,
          projectName: detail.projectName,
          projectSlug: detail.projectSlug,
          costMicrousd,
          previousCostMicrousd: projectPrevious.get(projectId) ?? 0n,
          managedCostMicrousd: projectManaged.get(projectId) ?? 0n,
          byokCostMicrousd: projectByok.get(projectId) ?? 0n,
        };
      })
      .sort((left, right) => Number(right.costMicrousd - left.costMicrousd)),
    topSandboxes: [...sandboxCurrent.entries()]
      .map(([sandboxId, costMicrousd]) => {
        const detail = sandboxDetails.get(sandboxId)!;
        return {
          sandboxId,
          projectId: detail.projectId,
          projectName: detail.projectName,
          projectSlug: detail.projectSlug,
          provider: detail.provider,
          billingMode: detail.billingMode,
          status: publicStatus(detail.status),
          costMicrousd,
          previousCostMicrousd: sandboxPrevious.get(sandboxId) ?? 0n,
          provenance: detail.provenance,
          confidence: detail.confidence,
          costSource: detail.costSource,
        };
      })
      .sort((left, right) => Number(right.costMicrousd - left.costMicrousd))
      .slice(0, 10),
    activity: activityRows.map((row) => ({
      id: row.id,
      measuredThrough: row.measuredThrough,
      sandboxId: row.sandboxId,
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
      provider: row.provider,
      billingMode: billingMode(row.billingMode),
      status: publicStatus(row.status),
      costDeltaMicrousd: row.costDeltaMicrousd,
      cumulativeCostMicrousd: row.cumulativeCostMicrousd,
      provenance: provenance(row.provenance),
      confidence: confidence(row.confidence),
      costSource: row.costSource,
      rateCardVersion: row.rateCardVersion,
    })),
    generatedAt,
  };
}
