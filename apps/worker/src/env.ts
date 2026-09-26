import { z } from "zod";

export const WorkerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BL_API_KEY: z.string().min(1).optional(),
  BL_WORKSPACE: z.string().min(1).optional(),
  BLAXEL_API_KEY: z.string().min(1).optional(),
  BLAXEL_WORKSPACE: z.string().min(1).optional(),
  BLAXEL_ACCOUNT_ID: z.string().min(1).optional(),
  BLAXEL_API_URL: z.string().url().optional(),
  BLAXEL_REGION: z.string().min(1).optional(),
  BLAXEL_DEFAULT_IMAGE: z.string().min(1).optional(),
  BLAXEL_DEFAULT_MEMORY_MB: z.coerce.number().int().min(512).optional(),
  NORTHFLANK_API_TOKEN: z.string().min(1).optional(),
  NORTHFLANK_PROJECT_ID: z.string().min(1).optional(),
  NORTHFLANK_TEAM_ID: z.string().min(1).optional(),
  NORTHFLANK_API_URL: z.string().url().optional(),
  NORTHFLANK_DEPLOYMENT_PLAN: z.string().min(1).optional(),
  NORTHFLANK_DEFAULT_IMAGE: z.string().min(1).optional(),
  NORTHFLANK_EPHEMERAL_STORAGE_MB: z.coerce.number().int().min(1_024).optional(),
  PRIME_API_KEY: z.string().min(1).optional(),
  PRIME_API_URL: z.string().url().optional(),
  PRIME_TEAM_ID: z.string().min(1).optional(),
  RUNLOOP_API_KEY: z.string().min(1).optional(),
  RUNLOOP_API_URL: z.string().url().optional(),
  RUNLOOP_RESOURCE_SIZE: z
    .enum(["X_SMALL", "SMALL", "MEDIUM", "LARGE", "X_LARGE", "XX_LARGE"])
    .optional(),
  RUNLOOP_BLUEPRINT_ID: z.string().min(1).optional(),
  RUNLOOP_VCPU_HOUR_RATE_USD: z.coerce.number().nonnegative().optional(),
  RUNLOOP_MEMORY_GB_HOUR_RATE_USD: z.coerce.number().nonnegative().optional(),
  RUNLOOP_DISK_GB_HOUR_RATE_USD: z.coerce.number().nonnegative().optional(),
  CODESANDBOX_API_KEY: z.string().min(1).optional(),
  CODESANDBOX_API_URL: z.string().url().optional(),
  CODESANDBOX_TEMPLATE_ID: z.string().min(1).optional(),
  CODESANDBOX_VM_TIER: z
    .enum(["Pico", "Nano", "Micro", "Small", "Medium", "Large", "XLarge"])
    .optional(),
  CODESANDBOX_WORKSPACE_ID: z.string().min(1).optional(),
  CODESANDBOX_CREDIT_RATE_USD: z.coerce.number().nonnegative().optional(),
  DAYTONA_API_KEY: z.string().min(1).optional(),
  DAYTONA_API_URL: z.string().url().optional(),
  DAYTONA_ANALYTICS_API_URL: z.string().url().optional(),
  DAYTONA_TARGET: z.string().min(1).optional(),
  DAYTONA_PAUSE_SUPPORTED: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  CLOUDFLARE_SANDBOX_API_URL: z.string().url().optional(),
  CLOUDFLARE_SANDBOX_API_KEY: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  CLOUDFLARE_ANALYTICS_API_TOKEN: z.string().min(1).optional(),
  E2B_API_KEY: z.string().min(1).optional(),
  E2B_API_URL: z.string().url().optional(),
  E2B_TEMPLATE_ID: z.string().min(1).optional(),
  FREESTYLE_API_KEY: z.string().min(1).optional(),
  FREESTYLE_API_URL: z.string().url().optional(),
  FREESTYLE_SNAPSHOT_ID: z.string().min(1).optional(),
  MODAL_TOKEN_ID: z.string().min(1).optional(),
  MODAL_TOKEN_SECRET: z.string().min(1).optional(),
  MODAL_TOKEN_PROFILE: z.string().min(1).optional(),
  MODAL_ENVIRONMENT: z.string().min(1).optional(),
  MODAL_APP_NAME: z.string().min(1).optional(),
  VERCEL_OIDC_TOKEN: z.string().min(1).optional(),
  VERCEL_TOKEN: z.string().min(1).optional(),
  VERCEL_TEAM_ID: z.string().min(1).optional(),
  VERCEL_PROJECT_ID: z.string().min(1).optional(),
  VERCEL_API_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),
  METAL_ENVIRONMENT: z.string().default("development"),
  WORKER_ID: z.string().min(1),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_POLL_MS: z.coerce.number().int().min(50).default(250),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).optional(),
  WORKER_MAINTENANCE_MS: z.coerce.number().int().min(250).default(1_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  WORKER_BASE_BACKOFF_MS: z.coerce.number().int().min(1).default(200),
  WORKER_COST_SWEEP_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(5 * 60_000),
  WORKER_PROCESS_EVENT_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(7 * 24 * 60 * 60_000),
  WORKER_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  WORKER_WEBHOOK_BASE_BACKOFF_MS: z.coerce.number().int().min(100).default(5_000),
  WORKER_WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

// Jobs spend most of their time waiting on providers, so two jobs per pooled
// connection keeps the pool busy without queueing every query behind it.
export function resolveWorkerConcurrency(env: WorkerEnv, poolMax: number): number {
  return env.WORKER_CONCURRENCY ?? Math.max(1, Math.min(16, poolMax * 2));
}

export function loadWorkerEnv(rawSource: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return WorkerEnvSchema.parse(
    Object.fromEntries(
      Object.keys(WorkerEnvSchema.shape).map((key) => {
        const value = rawSource[key];
        return [key, typeof value === "string" && value.trim() === "" ? undefined : value];
      }),
    ),
  );
}
