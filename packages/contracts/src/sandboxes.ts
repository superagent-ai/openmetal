import { z } from "zod";
import {
  CursorSchema,
  IsoDateTimeSchema,
  PaginationLimitSchema,
  ProjectIdSchema,
  SandboxIdSchema,
} from "./primitives.js";
import { OperationSchema } from "./operations.js";

export const SandboxStateSchema = z.enum([
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
]);
export type SandboxState = z.infer<typeof SandboxStateSchema>;
export const SandboxStatusSchema = SandboxStateSchema;
export type SandboxStatus = SandboxState;

export const SandboxProviderSchema = z.enum([
  "blaxel",
  "cloudflare",
  "codesandbox",
  "daytona",
  "e2b",
  "modal",
  "northflank",
  "runloop",
  "vercel",
]);
export type SandboxProvider = z.infer<typeof SandboxProviderSchema>;
export const SandboxProviderSelectionSchema = z.union([SandboxProviderSchema, z.literal("auto")]);
export type SandboxProviderSelection = z.infer<typeof SandboxProviderSelectionSchema>;

export const SandboxSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("environment"),
    environment: z.string().min(1).max(200),
    version: z.string().min(1).max(100).default("latest"),
  }),
  z.object({
    kind: z.literal("oci_image"),
    image: z.string().min(1).max(500),
    command: z.array(z.string().max(131_072)).max(4096).optional(),
  }),
  z.object({
    kind: z.literal("provider_template"),
    provider: SandboxProviderSchema,
    template: z.string().min(1).max(500),
  }),
]);
export type SandboxSource = z.infer<typeof SandboxSourceSchema>;

export const ResourceRequirementsSchema = z.object({
  vcpu: z.number().positive(),
  memory_mb: z.number().int().min(128),
  disk_mb: z.number().int().nonnegative().optional(),
  architecture: z.enum(["x86_64", "arm64", "any"]).default("any"),
});
export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>;

export const ResolvedResourcesSchema = z.object({
  vcpu: z.number().positive(),
  memory_mb: z.number().int().min(128),
  disk_mb: z.number().int().nonnegative().nullable(),
  architecture: z.enum(["x86_64", "arm64"]),
  provider_size: z.string().nullable(),
});
export type ResolvedResources = z.infer<typeof ResolvedResourcesSchema>;

export const LifecyclePolicySchema = z.object({
  runtime_timeout_seconds: z.number().int().min(1).max(172_800),
  idle_timeout_seconds: z.number().int().min(1).optional(),
  on_runtime_timeout: z.enum(["destroy", "pause"]).default("destroy"),
  on_idle_timeout: z.enum(["destroy", "pause"]).default("destroy"),
});
export type LifecyclePolicy = z.infer<typeof LifecyclePolicySchema>;

export const FallbackPolicySchema = z.object({
  providers: z.array(SandboxProviderSchema).max(8),
  max_attempts: z.number().int().min(1).max(9).optional(),
});
export type FallbackPolicy = z.infer<typeof FallbackPolicySchema>;

const ProviderOptionsBaseSchema = z.record(z.string(), z.unknown());
export const ProviderOptionsSchema = z.object({
  blaxel: ProviderOptionsBaseSchema.optional(),
  cloudflare: ProviderOptionsBaseSchema.optional(),
  codesandbox: z
    .object({
      template_id: z.string().optional(),
      vm_tier: z.enum(["Pico", "Nano", "Micro", "Small", "Medium", "Large", "XLarge"]).optional(),
    })
    .optional(),
  daytona: ProviderOptionsBaseSchema.optional(),
  e2b: z.object({ template_id: z.string().optional() }).optional(),
  modal: ProviderOptionsBaseSchema.optional(),
  northflank: z
    .object({
      deployment_plan: z.string().optional(),
      ephemeral_storage_mb: z.number().int().positive().optional(),
    })
    .optional(),
  runloop: z
    .object({
      resource_size: z
        .enum(["X_SMALL", "SMALL", "MEDIUM", "LARGE", "X_LARGE", "XX_LARGE"])
        .optional(),
      blueprint_id: z.string().optional(),
    })
    .optional(),
  vercel: ProviderOptionsBaseSchema.optional(),
});
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

export const IsolationRequirementSchema = z.enum(["microvm", "vm", "container"]);
export const PortableFeaturesSchema = z.object({
  isolation: z.array(IsolationRequirementSchema).min(1).optional(),
  pty: z.boolean().optional(),
  pause_resume: z.boolean().optional(),
  public_ports: z.array(z.number().int().min(1).max(65_535)).max(64).optional(),
});
export const NetworkRequirementsSchema = z
  .object({
    internet_access: z.boolean().optional(),
    allow_domains: z.array(z.string().min(1).max(253)).max(256).optional(),
    deny_domains: z.array(z.string().min(1).max(253)).max(256).optional(),
  })
  .superRefine((value, context) => {
    if (value.allow_domains?.length && value.deny_domains?.length) {
      context.addIssue({
        code: "custom",
        message: "allow_domains and deny_domains cannot both be set",
      });
    }
  });

export const CreateSandboxRequestSchema = z
  .object({
    provider: SandboxProviderSelectionSchema.optional(),
    source: SandboxSourceSchema,
    resources: ResourceRequirementsSchema,
    lifecycle: LifecyclePolicySchema,
    regions: z.array(z.string().min(1).max(100)).max(32).optional(),
    features: PortableFeaturesSchema.optional(),
    network: NetworkRequirementsSchema.optional(),
    fallback: FallbackPolicySchema.optional(),
    provider_options: ProviderOptionsSchema.optional(),
    environment: z.record(z.string(), z.string().max(16_384)).optional(),
    secret_refs: z.record(z.string(), z.string()).optional(),
    metadata: z.record(z.string(), z.string().max(500)).optional(),
  })
  .superRefine((value, context) => {
    const fallbackProviders = value.fallback?.providers ?? [];
    const candidates =
      value.provider && value.provider !== "auto"
        ? [value.provider, ...fallbackProviders]
        : fallbackProviders;
    if (new Set(candidates).size !== candidates.length) {
      context.addIssue({
        code: "custom",
        path: ["fallback", "providers"],
        message: "provider candidates must be unique",
      });
    }
    if (
      value.source.kind === "provider_template" &&
      ((value.provider && value.provider !== "auto" && value.source.provider !== value.provider) ||
        fallbackProviders.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "provider_template must target only the primary provider",
      });
    }
    for (const key of Object.keys(value.provider_options ?? {})) {
      if (
        value.provider !== undefined &&
        value.provider !== "auto" &&
        !candidates.includes(key as SandboxProvider)
      ) {
        context.addIssue({
          code: "custom",
          path: ["provider_options", key],
          message: "provider options require the provider to be selected",
        });
      }
    }
  });
export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequestSchema>;

export const SandboxSchema = z.object({
  id: SandboxIdSchema,
  type: z.literal("sandbox"),
  project_id: ProjectIdSchema,
  state: SandboxStateSchema,
  state_reason: z.string().nullable(),
  requested: CreateSandboxRequestSchema,
  provider: SandboxProviderSchema.nullable(),
  billing_mode: z.enum(["managed", "byok"]),
  resolved_resources: ResolvedResourcesSchema.nullable(),
  cost_microusd: z.string().regex(/^\d+$/).nullable(),
  cost_updated_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  ready_at: IsoDateTimeSchema.nullable(),
  paused_at: IsoDateTimeSchema.nullable(),
  stopped_at: IsoDateTimeSchema.nullable(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type Sandbox = z.infer<typeof SandboxSchema>;

export const SandboxMutationSchema = z.object({
  sandbox: SandboxSchema,
  operation: OperationSchema,
});
export type SandboxMutation = z.infer<typeof SandboxMutationSchema>;

export const ProjectSandboxListResponseSchema = z.object({
  sandboxes: z.array(SandboxSchema),
});
export type ProjectSandboxListResponse = z.infer<typeof ProjectSandboxListResponseSchema>;

export const ListSandboxesQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: PaginationLimitSchema.default(50),
});
export const SandboxListResponseSchema = z.object({
  sandboxes: z.array(SandboxSchema),
  next_cursor: CursorSchema.nullable(),
});
export type ListSandboxesQuery = z.infer<typeof ListSandboxesQuerySchema>;
export type SandboxListResponse = z.infer<typeof SandboxListResponseSchema>;
