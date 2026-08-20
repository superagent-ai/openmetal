import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";
import { OrganizationNameSchema, ResourceSlugSchema } from "./organizations.js";

export const ProjectSchema = z.object({
  id: OpaqueIdSchema,
  organization_id: OpaqueIdSchema,
  name: OrganizationNameSchema,
  slug: ResourceSlugSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z.object({
  name: OrganizationNameSchema,
  slug: ResourceSlugSchema,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
