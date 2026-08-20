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

export const OrganizationListResponseSchema = z.object({
  organizations: z.array(OrganizationSchema),
});
export type OrganizationListResponse = z.infer<typeof OrganizationListResponseSchema>;
