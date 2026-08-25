import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  organizationInvitations,
  organizationMembers,
  organizations,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import type {
  InvitationRole,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRole,
} from "@openmetal/contracts";
import { ApiError } from "./errors.js";
import { requireMembership } from "./services.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGE_ROLES = ["owner", "admin"] as const;

type AuthUserRow = {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
};

function invitationRedirectTo(siteUrl: string): string {
  const url = new URL("/auth/confirm", siteUrl);
  url.searchParams.set("next", "/dashboard");
  return url.toString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === "object" && "rows" in value && Array.isArray(value.rows)) {
    return value.rows as T[];
  }
  return [];
}

function invitationStatus(expiresAt: Date, now = new Date()): "pending" | "expired" {
  return expiresAt.getTime() > now.getTime() ? "pending" : "expired";
}

function serializeInvitation(
  row: typeof organizationInvitations.$inferSelect,
): OrganizationInvitation {
  return {
    id: row.id,
    organization_id: row.organizationId,
    email: row.email,
    role: row.role as InvitationRole,
    invited_by: row.invitedBy,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    status: invitationStatus(row.expiresAt),
  };
}

function serializeMember(
  row: typeof organizationMembers.$inferSelect,
  email: string,
): OrganizationMember {
  return {
    user_id: row.userId,
    email: normalizeEmail(email),
    role: row.role as OrganizationRole,
    created_at: row.createdAt.toISOString(),
  };
}

async function authUsersById(db: MetalDb, userIds: string[]): Promise<Map<string, AuthUserRow>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = asRows<AuthUserRow>(
    await db.execute(sql`
    select id::text as id, email::text as email, email_confirmed_at as "emailConfirmedAt"
    from auth.users
    where id in (${sql.join(
      unique.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function authUserById(db: MetalDb, userId: string): Promise<AuthUserRow | undefined> {
  const users = await authUsersById(db, [userId]);
  return users.get(userId);
}

async function authUserByEmail(db: MetalDb, email: string): Promise<AuthUserRow | undefined> {
  const rows = asRows<AuthUserRow>(
    await db.execute(sql`
    select id::text as id, email::text as email, email_confirmed_at as "emailConfirmedAt"
    from auth.users
    where lower(email) = ${email}
    limit 1
  `),
  );
  return rows[0];
}

async function sendInviteEmail(
  admin: SupabaseClient,
  input: { email: string; organizationName: string; redirectTo: string },
) {
  const invited = await admin.auth.admin.inviteUserByEmail(input.email, {
    data: { organization_name: input.organizationName },
    redirectTo: input.redirectTo,
  });
  if (!invited.error) {
    return;
  }
  const alreadyRegistered = /already (been )?registered/i.test(invited.error.message);
  if (!alreadyRegistered) {
    throw new ApiError(502, "internal_error", "failed to send invitation email", {
      cause: invited.error.message,
    });
  }
  const resent = await admin.auth.resend({
    type: "signup",
    email: input.email,
    options: { emailRedirectTo: input.redirectTo },
  });
  if (resent.error && !/already (been )?registered|rate limit/i.test(resent.error.message)) {
    throw new ApiError(502, "internal_error", "failed to resend invitation email", {
      cause: resent.error.message,
    });
  }
}

export async function acceptPendingInvitations(db: MetalDb, userId: string) {
  const user = await authUserById(db, userId);
  const email = user?.email ? normalizeEmail(user.email) : null;
  if (!email) {
    return;
  }
  const pending = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.email, email),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
        gt(organizationInvitations.expiresAt, new Date()),
      ),
    );
  if (pending.length === 0) {
    return;
  }
  await withTransaction(db, async (tx) => {
    for (const invitation of pending) {
      await tx
        .insert(organizationMembers)
        .values({
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
        })
        .onConflictDoNothing();
      await tx
        .update(organizationInvitations)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.id, invitation.id),
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
          ),
        );
    }
  });
}

export async function listOrganizationMembers(
  db: MetalDb,
  input: { userId: string; organizationId: string },
) {
  await acceptPendingInvitations(db, input.userId);
  const membership = await requireMembership(db, input.userId, input.organizationId);
  const members = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, input.organizationId));
  const invitations = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, input.organizationId),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
      ),
    );
  const emails = await authUsersById(
    db,
    members.map((member) => member.userId),
  );
  return {
    viewer: { user_id: input.userId, role: membership.role },
    members: members
      .map((member) => {
        const email = emails.get(member.userId)?.email;
        if (!email) {
          return null;
        }
        return serializeMember(member, email);
      })
      .filter((member): member is NonNullable<typeof member> => member !== null)
      .sort((left, right) => left.created_at.localeCompare(right.created_at)),
    invitations: invitations
      .map(serializeInvitation)
      .sort((left, right) => left.created_at.localeCompare(right.created_at)),
  };
}

export async function createOrganizationInvitation(
  db: MetalDb,
  admin: SupabaseClient,
  input: {
    userId: string;
    organizationId: string;
    email: string;
    role: InvitationRole;
    siteUrl: string;
  },
) {
  const membership = await requireMembership(db, input.userId, input.organizationId, [
    ...MANAGE_ROLES,
  ]);
  const email = normalizeEmail(input.email);
  const actor = await authUserById(db, input.userId);
  if (actor?.email && normalizeEmail(actor.email) === email) {
    throw new ApiError(422, "validation_error", "cannot invite yourself");
  }
  const organization = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .then((rows) => rows[0]);
  if (!organization) {
    throw new ApiError(404, "not_found", "organization not found");
  }
  const existingUser = await authUserByEmail(db, email);
  if (existingUser) {
    const alreadyMember = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.userId, existingUser.id),
        ),
      )
      .then((rows) => rows[0]);
    if (alreadyMember) {
      throw new ApiError(409, "conflict", "already a member of this organization");
    }
  }

  const pending = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, input.organizationId),
        eq(organizationInvitations.email, email),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
      ),
    )
    .then((rows) => rows[0]);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  let created = false;
  let invitation = pending;

  if (pending && invitationStatus(pending.expiresAt, now) === "pending") {
    invitation = pending;
  } else if (pending) {
    const [updated] = await db
      .update(organizationInvitations)
      .set({
        role: input.role,
        invitedBy: membership.userId,
        createdAt: now,
        expiresAt,
      })
      .where(eq(organizationInvitations.id, pending.id))
      .returning();
    invitation = updated ?? pending;
    created = true;
  } else {
    const [inserted] = await db
      .insert(organizationInvitations)
      .values({
        organizationId: input.organizationId,
        email,
        role: input.role,
        invitedBy: membership.userId,
        expiresAt,
      })
      .returning();
    if (!inserted) {
      throw new ApiError(500, "internal_error", "failed to create invitation");
    }
    invitation = inserted;
    created = true;
  }

  if (!invitation) {
    throw new ApiError(500, "internal_error", "failed to create invitation");
  }

  if (created && (!existingUser || !existingUser.emailConfirmedAt)) {
    await sendInviteEmail(admin, {
      email,
      organizationName: organization.name,
      redirectTo: invitationRedirectTo(input.siteUrl),
    });
  }

  return { invitation: serializeInvitation(invitation), created };
}

export async function resendOrganizationInvitation(
  db: MetalDb,
  admin: SupabaseClient,
  input: { userId: string; organizationId: string; invitationId: string; siteUrl: string },
) {
  await requireMembership(db, input.userId, input.organizationId, [...MANAGE_ROLES]);
  const invitation = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.id, input.invitationId),
        eq(organizationInvitations.organizationId, input.organizationId),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
      ),
    )
    .then((rows) => rows[0]);
  if (!invitation) {
    throw new ApiError(404, "not_found", "invitation not found");
  }
  const organization = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .then((rows) => rows[0]);
  if (!organization) {
    throw new ApiError(404, "not_found", "organization not found");
  }
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const [updated] = await db
    .update(organizationInvitations)
    .set({ expiresAt })
    .where(eq(organizationInvitations.id, invitation.id))
    .returning();
  const existingUser = await authUserByEmail(db, invitation.email);
  if (!existingUser || !existingUser.emailConfirmedAt) {
    await sendInviteEmail(admin, {
      email: invitation.email,
      organizationName: organization.name,
      redirectTo: invitationRedirectTo(input.siteUrl),
    });
  }
  return serializeInvitation(updated ?? { ...invitation, expiresAt });
}

export async function revokeOrganizationInvitation(
  db: MetalDb,
  input: { userId: string; organizationId: string; invitationId: string },
) {
  await requireMembership(db, input.userId, input.organizationId, [...MANAGE_ROLES]);
  const [row] = await db
    .update(organizationInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(organizationInvitations.id, input.invitationId),
        eq(organizationInvitations.organizationId, input.organizationId),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
      ),
    )
    .returning();
  if (!row) {
    throw new ApiError(404, "not_found", "invitation not found");
  }
  return { id: row.id, revoked: true as const };
}

export async function updateOrganizationMember(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    memberUserId: string;
    role: InvitationRole;
  },
) {
  await requireMembership(db, input.userId, input.organizationId, [...MANAGE_ROLES]);
  if (input.userId === input.memberUserId) {
    throw new ApiError(422, "validation_error", "cannot change your own role");
  }
  const target = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.memberUserId),
      ),
    )
    .then((rows) => rows[0]);
  if (!target) {
    throw new ApiError(404, "not_found", "member not found");
  }
  if (target.role === "owner") {
    throw new ApiError(403, "forbidden", "cannot change an owner's role");
  }
  const [updated] =
    target.role === input.role
      ? [target]
      : await db
          .update(organizationMembers)
          .set({ role: input.role })
          .where(
            and(
              eq(organizationMembers.organizationId, input.organizationId),
              eq(organizationMembers.userId, input.memberUserId),
            ),
          )
          .returning();
  if (!updated) {
    throw new ApiError(404, "not_found", "member not found");
  }
  const email = (await authUserById(db, updated.userId))?.email;
  if (!email) {
    throw new ApiError(404, "not_found", "member not found");
  }
  return serializeMember(updated, email);
}

export async function updateOrganizationInvitation(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    invitationId: string;
    role: InvitationRole;
  },
) {
  await requireMembership(db, input.userId, input.organizationId, [...MANAGE_ROLES]);
  const [updated] = await db
    .update(organizationInvitations)
    .set({ role: input.role })
    .where(
      and(
        eq(organizationInvitations.id, input.invitationId),
        eq(organizationInvitations.organizationId, input.organizationId),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
      ),
    )
    .returning();
  if (!updated) {
    throw new ApiError(404, "not_found", "invitation not found");
  }
  return serializeInvitation(updated);
}

export async function removeOrganizationMember(
  db: MetalDb,
  input: { userId: string; organizationId: string; memberUserId: string },
) {
  const actor = await requireMembership(db, input.userId, input.organizationId, [...MANAGE_ROLES]);
  const target = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.memberUserId),
      ),
    )
    .then((rows) => rows[0]);
  if (!target) {
    throw new ApiError(404, "not_found", "member not found");
  }
  if (target.role === "owner") {
    if (actor.role !== "owner") {
      throw new ApiError(403, "forbidden", "only owners can remove organization owners");
    }
    const owners = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.role, "owner"),
        ),
      );
    if (owners.length <= 1) {
      throw new ApiError(409, "conflict", "cannot remove the last owner");
    }
  }
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.memberUserId),
      ),
    );
  return { user_id: input.memberUserId, deleted: true as const };
}
