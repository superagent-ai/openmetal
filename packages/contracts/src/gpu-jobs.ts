import { z } from "zod";
import {
  CursorSchema,
  GpuJobIdSchema,
  IsoDateTimeSchema,
  PaginationLimitSchema,
  ProjectIdSchema,
} from "./primitives.js";
import { OperationSchema } from "./operations.js";
import { Base64PayloadSchema, PortablePathSchema } from "./runtime.js";

export const GPU_JOB_MAX_RUNTIME_SECONDS = 86_400;
export const GPU_JOB_MIN_RUNTIME_SECONDS = 60;
export const GPU_JOB_DEFAULT_MAX_START_SECONDS = 1_800;
export const GPU_JOB_MAX_MOUNTS = 8;
export const GPU_JOB_MAX_GPU_COUNT = 8;
export const GPU_JOB_MAX_ENVIRONMENT_ENTRIES = 128;
export const GPU_JOB_MAX_SECRET_ENTRIES = 64;
export const GPU_JOB_MAX_SECRET_BYTES = 65_536;
export const GPU_JOB_MAX_LOG_BYTES = 33_554_432;

export const GpuTypeSchema = z.enum([
  "nvidia-t4",
  "nvidia-l4",
  "nvidia-a10",
  "nvidia-l40s",
  "nvidia-a100-40gb",
  "nvidia-a100-80gb",
  "nvidia-rtx-pro-6000",
  "nvidia-h100",
  "nvidia-h200",
  "nvidia-b200",
  "nvidia-b300",
]);
export type GpuType = z.infer<typeof GpuTypeSchema>;

export const GpuJobProviderSchema = z.enum(["modal"]);
export type GpuJobProvider = z.infer<typeof GpuJobProviderSchema>;
export const GpuJobProviderSelectionSchema = z.union([GpuJobProviderSchema, z.literal("auto")]);
export type GpuJobProviderSelection = z.infer<typeof GpuJobProviderSelectionSchema>;

export const GpuJobStateSchema = z.enum([
  "requested",
  "provisioning",
  "provision_unknown",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
export type GpuJobState = z.infer<typeof GpuJobStateSchema>;
export const TERMINAL_GPU_JOB_STATES = ["succeeded", "failed", "timed_out", "cancelled"] as const;

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const EnvironmentValueSchema = z.string().max(16_384);
const UsdAmountSchema = z
  .string()
  .regex(/^\d{1,6}(?:\.\d{1,6})?$/)
  .refine((value) => Number(value) > 0, "amount must be greater than zero");

export const GpuRegionSchema = z.enum([
  "us",
  "us-east",
  "us-central",
  "us-south",
  "us-west",
  "eu",
  "eu-west",
  "eu-north",
  "eu-south",
  "ap",
  "ap-northeast",
  "ap-southeast",
  "ap-south",
  "ap-melbourne",
  "jp",
  "au",
  "uk",
  "ca",
  "me",
  "sa",
  "af",
  "mx",
]);
export type GpuRegion = z.infer<typeof GpuRegionSchema>;

export const GpuJobPlacementSchema = z.object({
  regions: z
    .array(GpuRegionSchema)
    .min(1)
    .max(8)
    .refine((regions) => new Set(regions).size === regions.length, "regions must be unique")
    .optional(),
});
export type GpuJobPlacement = z.infer<typeof GpuJobPlacementSchema>;

const CredentialValueSchema = z.string().min(1).max(16_384);

export const GpuJobRegistryAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("basic"),
    username: CredentialValueSchema,
    password: CredentialValueSchema,
  }),
  z.object({
    kind: z.literal("aws_ecr"),
    access_key_id: CredentialValueSchema,
    secret_access_key: CredentialValueSchema,
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  }),
  z.object({
    kind: z.literal("gcp_artifact_registry"),
    service_account_json: CredentialValueSchema,
  }),
]);
export type GpuJobRegistryAuth = z.infer<typeof GpuJobRegistryAuthSchema>;

const GpuJobSourceBaseSchema = z.object({
  kind: z.literal("oci_image"),
  image: z.string().min(1).max(500),
  command: z.array(z.string().max(131_072)).min(1).max(4096),
  working_dir: PortablePathSchema.optional(),
});
export const GpuJobSourceSchema = GpuJobSourceBaseSchema.extend({
  registry_auth: GpuJobRegistryAuthSchema.optional(),
});
export type GpuJobSource = z.infer<typeof GpuJobSourceSchema>;
/** A job's source as returned by the API: registry credentials are never included. */
export const GpuJobSourceSummarySchema = GpuJobSourceBaseSchema.extend({
  registry_auth: z
    .object({ kind: z.enum(["basic", "aws_ecr", "gcp_artifact_registry"]) })
    .optional(),
});

const MountPathSchema = PortablePathSchema.refine((path) => path !== "/", "mount_path cannot be /");

const GpuJobBucketMountBaseSchema = z.object({
  kind: z.literal("bucket"),
  provider: z.enum(["s3", "r2", "gcs"]),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/),
  mount_path: MountPathSchema,
  key_prefix: z
    .string()
    .min(1)
    .max(1024)
    .refine((prefix) => prefix.endsWith("/"), "key_prefix must end with /")
    .optional(),
  endpoint_url: z.url({ protocol: /^https$/ }).optional(),
  region: z.string().min(1).max(64).optional(),
  read_only: z.boolean().default(false),
});
export const GpuJobBucketMountSchema = GpuJobBucketMountBaseSchema.extend({
  credentials: z.object({
    access_key_id: CredentialValueSchema,
    secret_access_key: CredentialValueSchema,
    session_token: CredentialValueSchema.optional(),
  }),
}).superRefine((mount, context) => {
  // S3 and R2 cap bucket names at 63 characters; GCS allows up to 222 with dots.
  if (mount.provider !== "gcs" && mount.bucket.length > 63) {
    context.addIssue({
      code: "custom",
      path: ["bucket"],
      message: `${mount.provider} bucket names are at most 63 characters`,
    });
  }
  if (mount.provider === "gcs" && mount.bucket.length > 63 && !mount.bucket.includes(".")) {
    context.addIssue({
      code: "custom",
      path: ["bucket"],
      message: "GCS bucket names longer than 63 characters must contain dots",
    });
  }
  if (mount.provider === "r2" && !mount.endpoint_url) {
    context.addIssue({
      code: "custom",
      path: ["endpoint_url"],
      message: "R2 mounts require the account's endpoint_url",
    });
  }
});
export type GpuJobBucketMount = z.input<typeof GpuJobBucketMountSchema>;
/** A mount as returned by the API: credentials are never included. */
export const GpuJobBucketMountSummarySchema = GpuJobBucketMountBaseSchema;

export const GpuRequirementSchema = z.object({
  type: GpuTypeSchema,
  count: z.number().int().min(1).max(GPU_JOB_MAX_GPU_COUNT).default(1),
});
export type GpuRequirement = z.infer<typeof GpuRequirementSchema>;

export const GpuJobResourcesSchema = z.object({
  vcpu: z.number().positive().max(256).optional(),
  memory_mb: z.number().int().min(128).max(2_097_152).optional(),
});
export type GpuJobResources = z.infer<typeof GpuJobResourcesSchema>;

export const GpuJobLifecycleSchema = z.object({
  max_runtime_seconds: z
    .number()
    .int()
    .min(GPU_JOB_MIN_RUNTIME_SECONDS)
    .max(GPU_JOB_MAX_RUNTIME_SECONDS),
  /** Time allowed from creation until the container starts, including waiting for GPUs. */
  max_start_seconds: z
    .number()
    .int()
    .min(60)
    .max(GPU_JOB_MAX_RUNTIME_SECONDS)
    .default(GPU_JOB_DEFAULT_MAX_START_SECONDS),
});
export type GpuJobLifecycle = z.infer<typeof GpuJobLifecycleSchema>;

export const GpuJobLimitsSchema = z.object({
  max_cost_usd: UsdAmountSchema.optional(),
});
export type GpuJobLimits = z.infer<typeof GpuJobLimitsSchema>;

export const ModalVolumeMountSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
  mount_path: MountPathSchema,
});
export type ModalVolumeMount = z.infer<typeof ModalVolumeMountSchema>;

export const GpuJobProviderOptionsSchema = z.object({
  modal: z
    .object({
      volumes: z
        .array(ModalVolumeMountSchema)
        .max(8)
        .refine(
          (volumes) => new Set(volumes.map((volume) => volume.mount_path)).size === volumes.length,
          "volume mount paths must be unique",
        )
        .optional(),
    })
    .strict()
    .optional(),
});
export type GpuJobProviderOptions = z.infer<typeof GpuJobProviderOptionsSchema>;

export const CreateGpuJobRequestSchema = z
  .object({
    provider: GpuJobProviderSelectionSchema.optional(),
    source: GpuJobSourceSchema,
    gpu: GpuRequirementSchema,
    resources: GpuJobResourcesSchema.optional(),
    placement: GpuJobPlacementSchema.optional(),
    lifecycle: GpuJobLifecycleSchema,
    limits: GpuJobLimitsSchema.optional(),
    environment: z.record(EnvironmentNameSchema, EnvironmentValueSchema).optional(),
    secrets: z.record(EnvironmentNameSchema, EnvironmentValueSchema).optional(),
    mounts: z.array(GpuJobBucketMountSchema).max(GPU_JOB_MAX_MOUNTS).optional(),
    provider_options: GpuJobProviderOptionsSchema.optional(),
    metadata: z.record(z.string().min(1).max(100), z.string().max(500)).optional(),
  })
  .superRefine((value, context) => {
    const mountPaths = [
      ...(value.mounts ?? []).map((mount) => mount.mount_path),
      ...(value.provider_options?.modal?.volumes ?? []).map((volume) => volume.mount_path),
    ];
    if (new Set(mountPaths).size !== mountPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["mounts"],
        message: "mount paths must be unique across mounts and volumes",
      });
    }
    if (value.source.working_dir && mountPaths.some((path) => value.source.working_dir === path)) {
      context.addIssue({
        code: "custom",
        path: ["source", "working_dir"],
        message: "working_dir cannot be a mount path",
      });
    }
    const environmentKeys = Object.keys(value.environment ?? {});
    const secretKeys = Object.keys(value.secrets ?? {});
    if (environmentKeys.length > GPU_JOB_MAX_ENVIRONMENT_ENTRIES) {
      context.addIssue({
        code: "custom",
        path: ["environment"],
        message: `environment accepts at most ${GPU_JOB_MAX_ENVIRONMENT_ENTRIES} entries`,
      });
    }
    if (secretKeys.length > GPU_JOB_MAX_SECRET_ENTRIES) {
      context.addIssue({
        code: "custom",
        path: ["secrets"],
        message: `secrets accepts at most ${GPU_JOB_MAX_SECRET_ENTRIES} entries`,
      });
    }
    const secretBytes = Object.entries(value.secrets ?? {}).reduce(
      (total, [key, secret]) => total + key.length + new TextEncoder().encode(secret).byteLength,
      0,
    );
    if (secretBytes > GPU_JOB_MAX_SECRET_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["secrets"],
        message: `secrets must not exceed ${GPU_JOB_MAX_SECRET_BYTES} bytes`,
      });
    }
    for (const key of secretKeys) {
      if (environmentKeys.includes(key)) {
        context.addIssue({
          code: "custom",
          path: ["secrets", key],
          message: "a name cannot appear in both environment and secrets",
        });
      }
    }
    if (Object.keys(value.metadata ?? {}).length > 50) {
      context.addIssue({
        code: "custom",
        path: ["metadata"],
        message: "metadata accepts at most 50 entries",
      });
    }
    for (const key of Object.keys(value.provider_options ?? {})) {
      if (value.provider !== undefined && value.provider !== "auto" && key !== value.provider) {
        context.addIssue({
          code: "custom",
          path: ["provider_options", key],
          message: "provider options require the provider to be selected",
        });
      }
    }
  });
export type CreateGpuJobRequest = z.input<typeof CreateGpuJobRequestSchema>;
export type ParsedCreateGpuJobRequest = z.infer<typeof CreateGpuJobRequestSchema>;

export const GpuJobRequestedSchema = z.object({
  provider: GpuJobProviderSelectionSchema,
  source: GpuJobSourceSummarySchema,
  gpu: z.object({ type: GpuTypeSchema, count: z.number().int().min(1) }),
  resources: GpuJobResourcesSchema.optional(),
  placement: GpuJobPlacementSchema.optional(),
  lifecycle: z.object({
    max_runtime_seconds: z.number().int().positive(),
    max_start_seconds: z.number().int().positive(),
  }),
  limits: GpuJobLimitsSchema.optional(),
  environment: z.record(z.string(), z.string()).optional(),
  secret_names: z.array(z.string()),
  mounts: z.array(GpuJobBucketMountSummarySchema).optional(),
  provider_options: GpuJobProviderOptionsSchema.optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const GpuJobPricingSchema = z.object({
  /** Applied to the provider's base rates; 1.00 unless the job is pinned to regions. */
  price_multiplier: z.string().regex(/^\d+\.\d{2}$/),
  estimated_hourly_cost_usd: z.string().regex(/^\d+\.\d{6}$/),
  rate_card_version: z.string().nullable(),
});

export const GpuJobResolvedSchema = z.object({
  gpu_type: GpuTypeSchema,
  gpu_count: z.number().int().min(1),
  vram_gb_per_gpu: z.number().int().positive(),
  provider_gpu: z.string(),
  vcpu: z.number().positive().nullable(),
  memory_mb: z.number().int().positive().nullable(),
});
export type GpuJobResolved = z.infer<typeof GpuJobResolvedSchema>;

export const GpuJobFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const GpuJobSchema = z.object({
  id: GpuJobIdSchema,
  type: z.literal("gpu_job"),
  project_id: ProjectIdSchema,
  state: GpuJobStateSchema,
  state_reason: z.string().nullable(),
  failure: GpuJobFailureSchema.nullable(),
  provider: GpuJobProviderSchema.nullable(),
  billing_mode: z.enum(["managed", "byok"]),
  requested: GpuJobRequestedSchema,
  resolved: GpuJobResolvedSchema.nullable(),
  pricing: GpuJobPricingSchema,
  exit_code: z.number().int().nullable(),
  cost_microusd: z.string().regex(/^\d+$/).nullable(),
  cost_updated_at: IsoDateTimeSchema.nullable(),
  logs_complete: z.boolean(),
  logs_truncated: z.boolean(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  /** When the provider accepted the job; the container may still be waiting for GPUs. */
  submitted_at: IsoDateTimeSchema.nullable(),
  /** When the container started. Runtime limits are measured from here. */
  started_at: IsoDateTimeSchema.nullable(),
  finished_at: IsoDateTimeSchema.nullable(),
  cancel_requested_at: IsoDateTimeSchema.nullable(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type GpuJob = z.infer<typeof GpuJobSchema>;

export const GpuJobMutationSchema = z.object({
  gpu_job: GpuJobSchema,
  operation: OperationSchema,
});
export type GpuJobMutation = z.infer<typeof GpuJobMutationSchema>;

export const ListGpuJobsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: PaginationLimitSchema.default(50),
  state: GpuJobStateSchema.optional(),
});
export type ListGpuJobsQuery = z.infer<typeof ListGpuJobsQuerySchema>;

export const GpuJobListResponseSchema = z.object({
  gpu_jobs: z.array(GpuJobSchema),
  next_cursor: CursorSchema.nullable(),
});
export type GpuJobListResponse = z.infer<typeof GpuJobListResponseSchema>;

const GpuJobLogEventBaseSchema = z.object({
  sequence: z.number().int().positive(),
  gpu_job_id: GpuJobIdSchema,
  occurred_at: IsoDateTimeSchema,
});
export const GpuJobLogEventSchema = z.discriminatedUnion("type", [
  GpuJobLogEventBaseSchema.extend({
    type: z.literal("stdout"),
    data: z.object({
      data_base64: Base64PayloadSchema,
      byte_length: z.number().int().nonnegative(),
      stream_offset_bytes: z.number().int().nonnegative(),
    }),
  }),
  GpuJobLogEventBaseSchema.extend({
    type: z.literal("stderr"),
    data: z.object({
      data_base64: Base64PayloadSchema,
      byte_length: z.number().int().nonnegative(),
      stream_offset_bytes: z.number().int().nonnegative(),
    }),
  }),
  GpuJobLogEventBaseSchema.extend({
    type: z.literal("truncated"),
    data: z.object({ limit_bytes: z.number().int().positive() }),
  }),
]);
export type GpuJobLogEvent = z.infer<typeof GpuJobLogEventSchema>;

export const GpuOfferSchema = z.object({
  provider: GpuJobProviderSchema,
  provider_gpu: z.string(),
  max_count: z.number().int().positive(),
  max_runtime_seconds: z.number().int().positive(),
  price_per_gpu_hour_usd: z.string().regex(/^\d+\.\d{6}$/),
  cpu_price_per_core_hour_usd: z.string().regex(/^\d+\.\d{6}$/),
  memory_price_per_gib_hour_usd: z.string().regex(/^\d+\.\d{6}$/),
  billing_granularity: z.literal("per_second"),
  /** Multipliers applied to every rate when a job is pinned to regions. */
  region_price_multipliers: z.object({
    broad: z.string().regex(/^\d+\.\d{2}$/),
    narrow: z.string().regex(/^\d+\.\d{2}$/),
  }),
  rate_card_version: z.string(),
});

export const GpuTypeDescriptionSchema = z.object({
  id: GpuTypeSchema,
  name: z.string(),
  vram_gb: z.number().int().positive(),
  offers: z.array(GpuOfferSchema),
});

export const GpuRegionDescriptionSchema = z.object({
  id: GpuRegionSchema,
  name: z.string(),
  /** Broad regions span a continent; narrow ones pin a smaller area and cost more. */
  scope: z.enum(["broad", "narrow"]),
});

export const GpuTypeCatalogResponseSchema = z.object({
  gpu_types: z.array(GpuTypeDescriptionSchema),
  regions: z.array(GpuRegionDescriptionSchema),
});
export type GpuTypeCatalogResponse = z.infer<typeof GpuTypeCatalogResponseSchema>;
