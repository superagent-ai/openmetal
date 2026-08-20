import { z } from "zod";
import { API_SEMVER, API_VERSION } from "./primitives.js";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadinessCheckSchema = z.enum(["ok", "error"]);

export const ReadinessResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  checks: z.object({
    database: ReadinessCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const ApiMetadataResponseSchema = z.object({
  name: z.literal("metal"),
  version: z.string().min(1),
  api_version: z.literal(API_VERSION),
  semver: z.string().min(1).default(API_SEMVER),
});
export type ApiMetadataResponse = z.infer<typeof ApiMetadataResponseSchema>;
