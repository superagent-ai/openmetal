import { z } from "zod";

export const ApiEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  METAL_API_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),
  METAL_ENVIRONMENT: z.string().default("development"),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return ApiEnvSchema.parse({
    DATABASE_URL: source.DATABASE_URL,
    SUPABASE_URL: source.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      source.SUPABASE_PUBLISHABLE_KEY ?? source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    METAL_API_URL: source.METAL_API_URL,
    LOG_LEVEL: source.LOG_LEVEL,
    METAL_ENVIRONMENT: source.METAL_ENVIRONMENT,
    CORS_ALLOWED_ORIGINS: source.CORS_ALLOWED_ORIGINS,
    API_HOST: source.API_HOST,
    API_PORT: source.API_PORT,
    API_REQUEST_TIMEOUT_MS: source.API_REQUEST_TIMEOUT_MS,
  });
}
