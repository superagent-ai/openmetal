import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";

export const ProjectApiKeySchema = z.object({
  id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  name: z.string().trim().min(1).max(120),
  prefix: z.string().min(8).max(32),
  created_at: IsoDateTimeSchema,
  last_used_at: IsoDateTimeSchema.nullable(),
  expires_at: IsoDateTimeSchema.nullable(),
  revoked_at: IsoDateTimeSchema.nullable(),
  deleted_at: IsoDateTimeSchema.nullable(),
});
export type ProjectApiKey = z.infer<typeof ProjectApiKeySchema>;

export const ApiKeyExpirationSchema = z
  .enum(["1h", "1d", "7d", "30d", "90d", "180d", "1y"])
  .nullable();
export type ApiKeyExpiration = z.infer<typeof ApiKeyExpirationSchema>;

export const CreateProjectApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  expires_in: ApiKeyExpirationSchema.optional().default(null),
});
export type CreateProjectApiKeyRequest = z.infer<typeof CreateProjectApiKeyRequestSchema>;

export const CreateProjectApiKeyResponseSchema = z.object({
  api_key: ProjectApiKeySchema,
  key: z.string().startsWith("metal_sk_"),
});
export type CreateProjectApiKeyResponse = z.infer<typeof CreateProjectApiKeyResponseSchema>;

export const ProjectApiKeyListResponseSchema = z.object({
  api_keys: z.array(ProjectApiKeySchema),
});
export type ProjectApiKeyListResponse = z.infer<typeof ProjectApiKeyListResponseSchema>;
