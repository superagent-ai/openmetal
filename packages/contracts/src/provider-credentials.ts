import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";
import { SandboxProviderSchema } from "./sandboxes.js";

const SecretSchema = z.string().min(1).max(16_384);
const AccountValueSchema = z.string().trim().min(1).max(500);

export const ProviderCredentialInputSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("blaxel"),
    api_key: SecretSchema,
    workspace: AccountValueSchema,
    account_id: AccountValueSchema.optional(),
  }),
  z.object({
    provider: z.literal("cloudflare"),
    api_url: z.url().max(2_048),
    api_key: SecretSchema,
    account_id: AccountValueSchema.optional(),
    analytics_token: SecretSchema.optional(),
  }),
  z.object({
    provider: z.literal("codesandbox"),
    api_key: SecretSchema,
    workspace_id: AccountValueSchema.optional(),
  }),
  z.object({
    provider: z.literal("daytona"),
    api_key: SecretSchema,
    organization_id: AccountValueSchema.optional(),
    target: AccountValueSchema.optional(),
  }),
  z.object({
    provider: z.literal("e2b"),
    api_key: SecretSchema,
  }),
  z.object({
    provider: z.literal("modal"),
    token_id: SecretSchema,
    token_secret: SecretSchema,
    environment: AccountValueSchema.optional(),
  }),
  z.object({
    provider: z.literal("northflank"),
    api_token: SecretSchema,
    project_id: AccountValueSchema,
    team_id: AccountValueSchema.optional(),
  }),
  z.object({
    provider: z.literal("runloop"),
    api_key: SecretSchema,
  }),
  z.object({
    provider: z.literal("vercel"),
    token: SecretSchema,
    project_id: AccountValueSchema,
    team_id: AccountValueSchema.optional(),
  }),
]);
export type ProviderCredentialInput = z.infer<typeof ProviderCredentialInputSchema>;

export const ConfiguredProviderCredentialSchema = z.object({
  id: OpaqueIdSchema,
  organization_id: OpaqueIdSchema,
  provider: SandboxProviderSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type ConfiguredProviderCredential = z.infer<typeof ConfiguredProviderCredentialSchema>;

export const ProviderCredentialListResponseSchema = z.object({
  provider_credentials: z.array(ConfiguredProviderCredentialSchema),
});
export type ProviderCredentialListResponse = z.infer<typeof ProviderCredentialListResponseSchema>;

export const ProviderCredentialDeleteResponseSchema = z.object({
  provider: SandboxProviderSchema,
  deleted: z.literal(true),
});
export type ProviderCredentialDeleteResponse = z.infer<
  typeof ProviderCredentialDeleteResponseSchema
>;
