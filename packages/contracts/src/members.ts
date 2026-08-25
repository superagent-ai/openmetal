import { z } from "zod";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const InvitationRoleSchema = z.enum(["admin", "member"]);
export type InvitationRole = z.infer<typeof InvitationRoleSchema>;

export const OrganizationMemberSchema = z.object({
  user_id: OpaqueIdSchema,
  email: z.email(),
  role: OrganizationRoleSchema,
  created_at: IsoDateTimeSchema,
});
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const OrganizationInvitationStatusSchema = z.enum(["pending", "expired"]);
export type OrganizationInvitationStatus = z.infer<typeof OrganizationInvitationStatusSchema>;

export const OrganizationInvitationSchema = z.object({
  id: OpaqueIdSchema,
  organization_id: OpaqueIdSchema,
  email: z.email(),
  role: InvitationRoleSchema,
  invited_by: OpaqueIdSchema,
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  status: OrganizationInvitationStatusSchema,
});
export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>;

export const OrganizationMembersResponseSchema = z.object({
  viewer: z.object({
    user_id: OpaqueIdSchema,
    role: OrganizationRoleSchema,
  }),
  members: z.array(OrganizationMemberSchema),
  invitations: z.array(OrganizationInvitationSchema),
});
export type OrganizationMembersResponse = z.infer<typeof OrganizationMembersResponseSchema>;

export const CreateOrganizationInvitationRequestSchema = z.object({
  email: z.email().max(320),
  role: InvitationRoleSchema.default("member"),
});
export type CreateOrganizationInvitationRequest = z.infer<
  typeof CreateOrganizationInvitationRequestSchema
>;

export const UpdateOrganizationRoleRequestSchema = z.object({
  role: InvitationRoleSchema,
});
export type UpdateOrganizationRoleRequest = z.infer<typeof UpdateOrganizationRoleRequestSchema>;

export const OrganizationMemberDeleteResponseSchema = z.object({
  user_id: OpaqueIdSchema,
  deleted: z.literal(true),
});
export type OrganizationMemberDeleteResponse = z.infer<
  typeof OrganizationMemberDeleteResponseSchema
>;

export const OrganizationInvitationRevokeResponseSchema = z.object({
  id: OpaqueIdSchema,
  revoked: z.literal(true),
});
export type OrganizationInvitationRevokeResponse = z.infer<
  typeof OrganizationInvitationRevokeResponseSchema
>;
