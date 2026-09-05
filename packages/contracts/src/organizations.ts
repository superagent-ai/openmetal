import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";

export const OrganizationNameSchema = z.string().trim().min(1).max(120);
export const ResourceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case");

export const OrganizationSchema = z.object({
  id: OpaqueIdSchema,
  name: OrganizationNameSchema,
  slug: ResourceSlugSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const CreateOrganizationRequestSchema = z.object({
  name: OrganizationNameSchema,
  slug: ResourceSlugSchema,
});
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const UpdateOrganizationRequestSchema = z.object({
  name: OrganizationNameSchema,
  slug: ResourceSlugSchema,
});
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>;

export const DeleteOrganizationRequestSchema = z.object({
  confirm_name: OrganizationNameSchema,
  confirm_forfeit_balance: z.boolean().default(false),
});
export type DeleteOrganizationRequest = z.infer<typeof DeleteOrganizationRequestSchema>;

export const OrganizationDeleteResponseSchema = z.object({
  id: OpaqueIdSchema,
  deleted: z.literal(true),
});
export type OrganizationDeleteResponse = z.infer<typeof OrganizationDeleteResponseSchema>;

export const OrganizationListResponseSchema = z.object({
  organizations: z.array(OrganizationSchema),
});
export type OrganizationListResponse = z.infer<typeof OrganizationListResponseSchema>;
