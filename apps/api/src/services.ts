import { and, asc, eq, isNull } from "drizzle-orm";
import {
  domainEvents,
  organizationMembers,
  organizations,
  outboxJobs,
  projects,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import {
  organizationTopic,
  projectTopic,
  publicationDedupeKey,
  serializeCursor,
  toPublicEvent,
} from "@openmetal/events";
import { ApiError } from "./errors.js";

type Tx = MetalDb;

async function requireMembership(
  db: Tx,
  userId: string,
  organizationId: string,
  roles?: Array<"owner" | "admin" | "member">,
) {
  const membership = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .then((rows) => rows[0]);
  if (!membership) {
    throw new ApiError(403, "forbidden", "not a member of this organization");
  }
  if (roles && !roles.includes(membership.role)) {
    throw new ApiError(403, "forbidden", "insufficient organization role");
  }
  return membership;
}

async function requireProjectAccess(
  db: Tx,
  userId: string,
  projectId: string,
  roles?: Array<"owner" | "admin" | "member">,
) {
  const row = await db
    .select({
      project: projects,
      role: organizationMembers.role,
    })
    .from(projects)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, projects.organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .then((rows) => rows[0]);
  if (!row) {
    throw new ApiError(404, "not_found", "project not found");
  }
  if (roles && !roles.includes(row.role)) {
    throw new ApiError(403, "forbidden", "insufficient organization role");
  }
  return row.project;
}

async function insertEventAndOutbox(
  tx: Tx,
  input: {
    type: "organization.created" | "project.created" | "project.deleted" | "project.updated";
    organizationId: string;
    projectId?: string;
    actorId: string;
    data: Record<string, unknown>;
    topic: string;
  },
) {
  const [event] = await tx
    .insert(domainEvents)
    .values({
      type: input.type,
      organizationId: input.organizationId,
      projectId: input.projectId,
      actorId: input.actorId,
      payload: input.data,
    })
    .returning();
  if (!event) {
    throw new ApiError(500, "internal_error", "failed to persist domain event");
  }
  const publicEvent = toPublicEvent({
    cursor: serializeCursor(event.cursor),
    eventId: event.eventId,
    type: event.type,
    organizationId: event.organizationId,
    projectId: event.projectId,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
  await tx.insert(outboxJobs).values({
    jobType: "realtime.broadcast",
    dedupeKey: publicationDedupeKey(event.eventId),
    payload: {
      job_type: "realtime.broadcast",
      topic: input.topic,
      event: publicEvent,
    },
  });
  return publicEvent;
}

export async function createOrganization(
  tx: MetalDb,
  input: { userId: string; name: string; slug: string },
) {
  const [organization] = await tx
    .insert(organizations)
    .values({ name: input.name, slug: input.slug })
    .returning();
  if (!organization) {
    throw new ApiError(500, "internal_error", "failed to create organization");
  }
  await tx.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: input.userId,
    role: "owner",
  });
  await insertEventAndOutbox(tx, {
    type: "organization.created",
    organizationId: organization.id,
    actorId: input.userId,
    data: { name: organization.name, slug: organization.slug },
    topic: organizationTopic(organization.id),
  });
  return organization;
}

export async function listOrganizations(db: MetalDb, userId: string) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
    })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.createdAt));
}

export async function getOrganization(db: MetalDb, userId: string, organizationId: string) {
  await requireMembership(db, userId, organizationId);
  const organization = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .then((rows) => rows[0]);
  if (!organization) {
    throw new ApiError(404, "not_found", "organization not found");
  }
  return organization;
}

export async function createProject(
  tx: MetalDb,
  input: { userId: string; organizationId: string; name: string; slug: string },
) {
  await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
    })
    .returning();
  if (!project) {
    throw new ApiError(500, "internal_error", "failed to create project");
  }
  await insertEventAndOutbox(tx, {
    type: "project.created",
    organizationId: input.organizationId,
    projectId: project.id,
    actorId: input.userId,
    data: { name: project.name, slug: project.slug },
    topic: projectTopic(project.id),
  });
  return project;
}

export async function updateProject(
  db: MetalDb,
  input: { userId: string; projectId: string; name: string; slug: string },
) {
  return withTransaction(db, async (tx) => {
    await requireProjectAccess(tx, input.userId, input.projectId, ["owner", "admin"]);
    const [project] = await tx
      .update(projects)
      .set({
        name: input.name,
        slug: input.slug,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)))
      .returning();
    if (!project) {
      throw new ApiError(404, "not_found", "project not found");
    }

    await insertEventAndOutbox(tx, {
      type: "project.updated",
      organizationId: project.organizationId,
      projectId: project.id,
      actorId: input.userId,
      data: { name: project.name, slug: project.slug },
      topic: projectTopic(project.id),
    });
    return project;
  });
}

export async function deleteProject(db: MetalDb, input: { userId: string; projectId: string }) {
  return withTransaction(db, async (tx) => {
    await requireProjectAccess(tx, input.userId, input.projectId, ["owner", "admin"]);
    const now = new Date();
    const [project] = await tx
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)))
      .returning();
    if (!project) {
      throw new ApiError(404, "not_found", "project not found");
    }

    await insertEventAndOutbox(tx, {
      type: "project.deleted",
      organizationId: project.organizationId,
      projectId: project.id,
      actorId: input.userId,
      data: { name: project.name, slug: project.slug },
      topic: projectTopic(project.id),
    });
    return project;
  });
}

export async function listProjects(db: MetalDb, userId: string, organizationId: string) {
  await requireMembership(db, userId, organizationId);
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt)));
}

export async function getProject(db: MetalDb, userId: string, projectId: string) {
  return requireProjectAccess(db, userId, projectId);
}

export { requireMembership };
