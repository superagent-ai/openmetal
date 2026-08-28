import { z } from "zod";
import {
  IsoDateTimeSchema,
  PaginationLimitSchema,
  ProjectIdSchema,
  SandboxIdSchema,
} from "./primitives.js";
import { SandboxProviderSchema, SandboxStatusSchema } from "./sandboxes.js";

export const UsageBillingModeSchema = z.enum(["managed", "byok"]);
export type UsageBillingMode = z.infer<typeof UsageBillingModeSchema>;

export const CostProvenanceSchema = z.enum([
  "provider_reported",
  "provider_metered",
  "estimated_rate_card",
  "unknown",
]);
export type CostProvenance = z.infer<typeof CostProvenanceSchema>;

export const CostConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type CostConfidence = z.infer<typeof CostConfidenceSchema>;

export const UsageCostAmountSchema = z.object({
  microusd: z.string().regex(/^-?\d+$/),
  usd: z.string().regex(/^-?\d+\.\d{2}$/),
});
export type UsageCostAmount = z.infer<typeof UsageCostAmountSchema>;

export const OrganizationUsageQuerySchema = z
  .object({
    from: IsoDateTimeSchema.optional(),
    through: IsoDateTimeSchema.optional(),
    project_id: ProjectIdSchema.optional(),
    provider: SandboxProviderSchema.optional(),
    billing_mode: z.enum(["all", "managed", "byok"]).optional().default("all"),
    status: SandboxStatusSchema.optional(),
    cost_provenance: CostProvenanceSchema.optional(),
    sandbox_id: SandboxIdSchema.optional(),
    limit: PaginationLimitSchema.optional().default(100),
  })
  .refine(
    (value) =>
      !value.from ||
      !value.through ||
      new Date(value.from).getTime() < new Date(value.through).getTime(),
    {
      message: "from must be before through",
      path: ["from"],
    },
  );
export type OrganizationUsageQuery = z.input<typeof OrganizationUsageQuerySchema>;

export const UsageMetricSchema = z.object({
  current: UsageCostAmountSchema,
  previous: UsageCostAmountSchema,
  change_percent: z.number().nullable(),
});
export type UsageMetric = z.infer<typeof UsageMetricSchema>;

export const UsageCoverageItemSchema = z.object({
  provenance: CostProvenanceSchema,
  confidence: CostConfidenceSchema,
  cost: UsageCostAmountSchema,
  percent: z.number().min(0).max(100),
});
export type UsageCoverageItem = z.infer<typeof UsageCoverageItemSchema>;

export const UsageDailyGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  cost: UsageCostAmountSchema,
});
export type UsageDailyGroup = z.infer<typeof UsageDailyGroupSchema>;

export const UsageDailyBucketSchema = z.object({
  date: z.iso.date(),
  total_cost: UsageCostAmountSchema,
  managed_cost: UsageCostAmountSchema,
  byok_cost: UsageCostAmountSchema,
  providers: z.array(UsageDailyGroupSchema),
  projects: z.array(UsageDailyGroupSchema),
});
export type UsageDailyBucket = z.infer<typeof UsageDailyBucketSchema>;

export const UsageProviderBreakdownSchema = z.object({
  provider: SandboxProviderSchema,
  cost: UsageCostAmountSchema,
  previous_cost: UsageCostAmountSchema,
  change_percent: z.number().nullable(),
  share_percent: z.number().min(0).max(100),
  managed_cost: UsageCostAmountSchema,
  byok_cost: UsageCostAmountSchema,
  reported_percent: z.number().min(0).max(100),
});
export type UsageProviderBreakdown = z.infer<typeof UsageProviderBreakdownSchema>;

export const UsageProjectBreakdownSchema = z.object({
  project_id: ProjectIdSchema,
  project_name: z.string(),
  project_slug: z.string(),
  cost: UsageCostAmountSchema,
  previous_cost: UsageCostAmountSchema,
  change_percent: z.number().nullable(),
  share_percent: z.number().min(0).max(100),
  managed_cost: UsageCostAmountSchema,
  byok_cost: UsageCostAmountSchema,
});
export type UsageProjectBreakdown = z.infer<typeof UsageProjectBreakdownSchema>;

export const UsageSandboxBreakdownSchema = z.object({
  sandbox_id: SandboxIdSchema,
  project_id: ProjectIdSchema,
  project_name: z.string(),
  project_slug: z.string(),
  provider: SandboxProviderSchema,
  billing_mode: UsageBillingModeSchema,
  status: SandboxStatusSchema,
  cost: UsageCostAmountSchema,
  previous_cost: UsageCostAmountSchema,
  change_percent: z.number().nullable(),
  provenance: CostProvenanceSchema,
  confidence: CostConfidenceSchema,
  cost_source: z.string().nullable(),
});
export type UsageSandboxBreakdown = z.infer<typeof UsageSandboxBreakdownSchema>;

export const UsageActivityItemSchema = z.object({
  id: z.uuid(),
  measured_through: IsoDateTimeSchema,
  sandbox_id: SandboxIdSchema,
  project_id: ProjectIdSchema,
  project_name: z.string(),
  project_slug: z.string(),
  provider: SandboxProviderSchema,
  billing_mode: UsageBillingModeSchema,
  status: SandboxStatusSchema,
  cost_delta: UsageCostAmountSchema,
  cumulative_cost: UsageCostAmountSchema,
  provenance: CostProvenanceSchema,
  confidence: CostConfidenceSchema,
  cost_source: z.string().nullable(),
  rate_card_version: z.string().nullable(),
});
export type UsageActivityItem = z.infer<typeof UsageActivityItemSchema>;

export const OrganizationUsageSchema = z.object({
  organization_id: z.uuid(),
  period: z.object({
    from: IsoDateTimeSchema,
    through: IsoDateTimeSchema,
    comparison_from: IsoDateTimeSchema,
    comparison_through: IsoDateTimeSchema,
    timezone: z.literal("UTC"),
  }),
  summary: z.object({
    total_cost: UsageMetricSchema,
    managed_cost: UsageMetricSchema,
    byok_cost: UsageMetricSchema,
    projected_month_end: UsageCostAmountSchema,
  }),
  coverage: z.object({
    available_percent: z.number().min(0).max(100),
    items: z.array(UsageCoverageItemSchema),
    unavailable_sandbox_count: z.number().int().nonnegative(),
  }),
  daily: z.array(UsageDailyBucketSchema),
  by_provider: z.array(UsageProviderBreakdownSchema),
  by_project: z.array(UsageProjectBreakdownSchema),
  top_sandboxes: z.array(UsageSandboxBreakdownSchema),
  activity: z.array(UsageActivityItemSchema),
  generated_at: IsoDateTimeSchema,
});
export type OrganizationUsage = z.infer<typeof OrganizationUsageSchema>;
