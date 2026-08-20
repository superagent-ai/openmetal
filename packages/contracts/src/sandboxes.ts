import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";

export const SandboxStatusSchema = z.enum([
  "requested",
  "provisioning",
  "ready",
  "pausing",
  "paused",
  "provision_unknown",
  "failed",
  "deleting",
  "deleted",
  "cleanup_pending",
  "cleanup_failed",
]);
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const SandboxSchema = z.object({
  id: OpaqueIdSchema,
  type: z.literal("sandbox"),
  organization_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  provider: z.literal("daytona"),
  provider_cost_microusd: z.string().regex(/^\d+$/).nullable(),
  provider_cost_measured_through: IsoDateTimeSchema.nullable(),
  provider_cost_updated_at: IsoDateTimeSchema.nullable(),
  status: SandboxStatusSchema,
  image: z.string().min(1).max(500).nullable(),
  language: z.string().min(1).max(64),
  error_code: z.string().min(1).max(100).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  ready_at: IsoDateTimeSchema.nullable(),
  paused_at: IsoDateTimeSchema.nullable(),
  deleted_at: IsoDateTimeSchema.nullable(),
});
export type Sandbox = z.infer<typeof SandboxSchema>;

export const CreateSandboxRequestSchema = z.object({
  project_id: OpaqueIdSchema.optional(),
  image: z.string().trim().min(1).max(500).optional(),
  language: z.string().trim().min(1).max(64).default("typescript"),
  ttl_minutes: z.number().int().min(1).max(1440).default(30),
});
export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequestSchema>;
