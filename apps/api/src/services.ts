import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  autoTopupAttempts,
  creditPurchases,
  insertDomainEventAndBroadcast,
  organizationInvitations,
  organizationMembers,
  organizationProviderCredentials,
  organizations,
  runtimeOperations,
  sandboxEndpoints,
  sandboxProcesses,
  outboxJobs,
  projects,
  operations,
  sandboxes,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import { organizationTopic, projectTopic } from "@openmetal/events";
import type { CreateSandboxRequest } from "@openmetal/contracts";
import {
  ensureBillingAccount,
  maybeGrantWelcomeCredit,
  prepareOrganizationBillingDeletion,
  requirePositiveManagedBalance,
} from "@openmetal/billing";
import { ApiError } from "./errors.js";
import { createOperation } from "./operation-service.js";

type Tx = MetalDb;

async function requireMembership(
  db: Tx,
  userId: string,
  organizationId: string,
  roles?: Array<"owner" | "admin" | "member">,
) {
  const row = await db
    .select({ membership: organizationMembers })
    .from(organizationMembers)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, organizationMembers.organizationId),
        isNull(organizations.deletedAt),
      ),
    )
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .then((rows) => rows[0]);
  if (!row) {
    const activeOrganization = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .then((rows) => rows[0]);
    if (!activeOrganization) {
      throw new ApiError(404, "not_found", "organization not found");
    }
    throw new ApiError(403, "forbidden", "not a member of this organization");
  }
  const membership = row.membership;
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
    .where(
      and(
        projectId.startsWith("prj_")
          ? eq(projects.publicId, projectId)
          : eq(projects.id, projectId),
        isNull(projects.deletedAt),
      ),
    )
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
    type: string;
    organizationId: string;
    projectId?: string;
    actorId: string;
    data: Record<string, unknown>;
    topic: string;
  },
) {
  const { publicEvent } = await insertDomainEventAndBroadcast(tx, {
    type: input.type,
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    data: input.data,
    topic: input.topic,
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
  await ensureBillingAccount(tx, organization.id);
  await maybeGrantWelcomeCredit(tx, {
    userId: input.userId,
    organizationId: organization.id,
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
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.createdAt));
}

export async function getOrganization(db: MetalDb, userId: string, organizationId: string) {
  await requireMembership(db, userId, organizationId);
  const organization = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
    .then((rows) => rows[0]);
  if (!organization) {
    throw new ApiError(404, "not_found", "organization not found");
  }
  return organization;
}

export async function updateOrganization(
  db: MetalDb,
  input: { userId: string; organizationId: string; name: string; slug: string },
) {
  return withTransaction(db, async (tx) => {
    await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
    const [organization] = await tx
      .update(organizations)
      .set({
        name: input.name,
        slug: input.slug,
        updatedAt: new Date(),
      })
      .where(and(eq(organizations.id, input.organizationId), isNull(organizations.deletedAt)))
      .returning();
    if (!organization) {
      throw new ApiError(404, "not_found", "organization not found");
    }

    await insertEventAndOutbox(tx, {
      type: "organization.updated",
      organizationId: organization.id,
      actorId: input.userId,
      data: { name: organization.name, slug: organization.slug },
      topic: organizationTopic(organization.id),
    });
    return organization;
  });
}

async function requireOrganizationDeletionReady(tx: MetalDb, organizationId: string) {
  const [blockingSandbox] = await tx
    .select({ id: sandboxes.publicId, state: sandboxes.status })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.organizationId, organizationId),
        isNull(sandboxes.deletedAt),
        notInArray(sandboxes.status, ["stopped", "failed"]),
      ),
    )
    .limit(1);
  if (blockingSandbox) {
    throw new ApiError(
      409,
      "organization_has_active_resources",
      "stop all sandboxes before deleting the organization",
      { resource: "sandbox", id: blockingSandbox.id, state: blockingSandbox.state },
    );
  }

  const [blockingOperation] = await tx
    .select({ id: operations.publicId, state: operations.state })
    .from(operations)
    .where(
      and(
        eq(operations.organizationId, organizationId),
        notInArray(operations.state, ["succeeded", "failed", "cancelled"]),
      ),
    )
    .limit(1);
  if (blockingOperation) {
    throw new ApiError(
      409,
      "organization_has_active_resources",
      "wait for organization operations to finish before deleting the organization",
      { resource: "operation", id: blockingOperation.id, state: blockingOperation.state },
    );
  }

  const [blockingProcess] = await tx
    .select({ id: sandboxProcesses.publicId, state: sandboxProcesses.state })
    .from(sandboxProcesses)
    .where(
      and(
        eq(sandboxProcesses.organizationId, organizationId),
        notInArray(sandboxProcesses.state, ["succeeded", "failed", "cancelled", "timed_out"]),
      ),
    )
    .limit(1);
  if (blockingProcess) {
    throw new ApiError(
      409,
      "organization_has_active_resources",
      "wait for organization processes to finish before deleting the organization",
      { resource: "process", id: blockingProcess.id, state: blockingProcess.state },
    );
  }

  const [blockingRuntimeOperation] = await tx
    .select({ id: runtimeOperations.publicId, state: runtimeOperations.state })
    .from(runtimeOperations)
    .where(
      and(
        eq(runtimeOperations.organizationId, organizationId),
        notInArray(runtimeOperations.state, ["succeeded", "failed", "cancelled"]),
      ),
    )
    .limit(1);
  if (blockingRuntimeOperation) {
    throw new ApiError(
      409,
      "organization_has_active_resources",
      "wait for runtime operations to finish before deleting the organization",
      {
        resource: "runtime_operation",
        id: blockingRuntimeOperation.id,
        state: blockingRuntimeOperation.state,
      },
    );
  }

  const [blockingEndpoint] = await tx
    .select({ id: sandboxEndpoints.publicId, state: sandboxEndpoints.state })
    .from(sandboxEndpoints)
    .where(
      and(
        eq(sandboxEndpoints.organizationId, organizationId),
        notInArray(sandboxEndpoints.state, ["revoked", "expired", "failed"]),
      ),
    )
    .limit(1);
  if (blockingEndpoint) {
    throw new ApiError(
      409,
      "organization_has_active_resources",
      "revoke all endpoints before deleting the organization",
      { resource: "endpoint", id: blockingEndpoint.id, state: blockingEndpoint.state },
    );
  }

  const [pendingPurchase] = await tx
    .select({ id: creditPurchases.id, status: creditPurchases.status })
    .from(creditPurchases)
    .where(
      and(
        eq(creditPurchases.organizationId, organizationId),
        inArray(creditPurchases.status, ["pending", "requires_action"]),
      ),
    )
    .limit(1);
  if (pendingPurchase) {
    throw new ApiError(
      409,
      "organization_has_pending_billing",
      "resolve pending billing before deleting the organization",
      { purchase_id: pendingPurchase.id, status: pendingPurchase.status },
    );
  }

  const [pendingTopup] = await tx
    .select({ id: autoTopupAttempts.id, status: autoTopupAttempts.status })
    .from(autoTopupAttempts)
    .where(
      and(
        eq(autoTopupAttempts.organizationId, organizationId),
        eq(autoTopupAttempts.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingTopup) {
    throw new ApiError(
      409,
      "organization_has_pending_billing",
      "wait for automatic top up to finish before deleting the organization",
      { auto_topup_attempt_id: pendingTopup.id, status: pendingTopup.status },
    );
  }
}

export async function deleteOrganization(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    confirmName: string;
    confirmForfeitBalance: boolean;
  },
) {
  return withTransaction(db, async (tx) => {
    await requireMembership(tx, input.userId, input.organizationId, ["owner"]);
    const organization = await tx
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, input.organizationId), isNull(organizations.deletedAt)))
      .then((rows) => rows[0]);
    if (!organization) {
      throw new ApiError(404, "not_found", "organization not found");
    }
    if (input.confirmName !== organization.name) {
      throw new ApiError(
        422,
        "confirmation_mismatch",
        "organization name confirmation does not match",
      );
    }

    await requireOrganizationDeletionReady(tx, organization.id);
    const billing = await prepareOrganizationBillingDeletion(tx, {
      organizationId: organization.id,
      actorId: input.userId,
      forfeitBalance: input.confirmForfeitBalance,
    });
    if (!billing.prepared) {
      throw new ApiError(
        409,
        "organization_has_credit_balance",
        "confirm credit forfeiture before deleting the organization",
        { balance_microusd: billing.balanceMicrousd.toString() },
      );
    }

    const now = new Date();
    const deletedProjects = await tx
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(projects.organizationId, organization.id), isNull(projects.deletedAt)))
      .returning();
    for (const project of deletedProjects) {
      await insertEventAndOutbox(tx, {
        type: "project.deleted",
        organizationId: organization.id,
        projectId: project.id,
        actorId: input.userId,
        data: { name: project.name, slug: project.slug },
        topic: projectTopic(project.publicId),
      });
    }

    await tx
      .update(organizationInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(organizationInvitations.organizationId, organization.id),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.revokedAt),
        ),
      );

    await insertEventAndOutbox(tx, {
      type: "organization.deleted",
      organizationId: organization.id,
      actorId: input.userId,
      data: { name: organization.name, slug: organization.slug },
      topic: organizationTopic(organization.id),
    });

    await tx
      .delete(organizationMembers)
      .where(eq(organizationMembers.organizationId, organization.id));
    const [deleted] = await tx
      .update(organizations)
      .set({
        name: "Deleted organization",
        slug: `deleted-${organization.id}`,
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(eq(organizations.id, organization.id), isNull(organizations.deletedAt)))
      .returning({ id: organizations.id });
    if (!deleted) {
      throw new ApiError(404, "not_found", "organization not found");
    }

    return {
      id: deleted.id,
      forfeitedMicrousd: billing.forfeitedMicrousd,
    };
  });
}

export async function createProject(
  tx: MetalDb,
  input: { userId: string; organizationId: string; name: string; slug: string },
) {
  await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
  const projectId = crypto.randomUUID();
  const [project] = await tx
    .insert(projects)
    .values({
      id: projectId,
      publicId: `prj_${projectId.replaceAll("-", "")}`,
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
    topic: projectTopic(project.publicId),
  });
  return project;
}

export async function updateProject(
  db: MetalDb,
  input: { userId: string; projectId: string; name: string; slug: string },
) {
  return withTransaction(db, async (tx) => {
    const existing = await requireProjectAccess(tx, input.userId, input.projectId, [
      "owner",
      "admin",
    ]);
    const [project] = await tx
      .update(projects)
      .set({
        name: input.name,
        slug: input.slug,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, existing.id), isNull(projects.deletedAt)))
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
      topic: projectTopic(project.publicId),
    });
    return project;
  });
}

export async function deleteProject(db: MetalDb, input: { userId: string; projectId: string }) {
  return withTransaction(db, async (tx) => {
    const existing = await requireProjectAccess(tx, input.userId, input.projectId, [
      "owner",
      "admin",
    ]);
    const now = new Date();
    const [project] = await tx
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(projects.id, existing.id), isNull(projects.deletedAt)))
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
      topic: projectTopic(project.publicId),
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

export async function createSandbox(
  tx: MetalDb,
  input: {
    organizationId: string;
    projectId: string;
    actorId: string;
    request: CreateSandboxRequest;
  },
) {
  const request = input.request;
  const requestedProvider = request.provider ?? "auto";
  const fallbackProviders = request.fallback?.providers ?? [];
  let managed = true;
  if (requestedProvider !== "auto" && fallbackProviders.length === 0) {
    const credential = await tx
      .select({ id: organizationProviderCredentials.id })
      .from(organizationProviderCredentials)
      .where(
        and(
          eq(organizationProviderCredentials.organizationId, input.organizationId),
          eq(organizationProviderCredentials.provider, requestedProvider),
          isNull(organizationProviderCredentials.disabledAt),
        ),
      )
      .then((rows) => rows[0]);
    managed = !credential;
  }
  try {
    await requirePositiveManagedBalance(tx, input.organizationId, managed);
  } catch (error) {
    if (error instanceof Error && error.name === "InsufficientCreditsError") {
      throw new ApiError(
        402,
        "insufficient_credits",
        "organization credit balance must be greater than zero for managed sandboxes",
      );
    }
    throw error;
  }
  const primaryProvider =
    request.source.kind === "provider_template" ? request.source.provider : requestedProvider;
  const storedProvider = primaryProvider === "auto" ? "daytona" : primaryProvider;
  const sandboxId = crypto.randomUUID();
  const image =
    request.source.kind === "oci_image"
      ? request.source.image
      : request.source.kind === "provider_template"
        ? request.source.template
        : undefined;
  const [sandbox] = await tx
    .insert(sandboxes)
    .values({
      id: sandboxId,
      publicId: `sbx_${sandboxId.replaceAll("-", "")}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      provider: storedProvider,
      primaryProvider,
      source: request.source,
      resourceRequirements: request.resources,
      lifecycle: request.lifecycle,
      regions: request.regions ?? [],
      features: request.features ?? {},
      network: request.network ?? {},
      fallback: request.fallback ?? { providers: [] },
      providerOptions: request.provider_options ?? {},
      environment: request.environment ?? {},
      secretRefs: request.secret_refs ?? {},
      metadata: request.metadata ?? {},
      image,
      language: request.source.kind === "environment" ? request.source.environment : "custom",
      ttlMinutes: Math.ceil(request.lifecycle.runtime_timeout_seconds / 60),
      status: "routing",
      createdBy: input.actorId,
    })
    .returning();
  if (!sandbox) {
    throw new ApiError(500, "internal_error", "failed to create sandbox");
  }
  await insertEventAndOutbox(tx, {
    type: "sandbox.requested",
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    data: { sandbox_id: sandbox.publicId, provider: requestedProvider },
    topic: projectTopic(`prj_${input.projectId.replaceAll("-", "")}`),
  });
  const operation = await createOperation(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    sandboxId: sandbox.id,
    type: "sandbox_create",
  });
  await tx.insert(outboxJobs).values({
    jobType: "sandbox.provision",
    dedupeKey: `sandbox:provision:${sandbox.id}`,
    payload: {
      job_type: "sandbox.provision",
      sandbox_id: sandbox.id,
      operation_id: operation.id,
    },
  });
  return { sandbox, operation };
}

export async function getSandbox(
  db: MetalDb,
  input: { sandboxId: string; organizationId: string; projectId: string },
) {
  const sandbox = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        input.sandboxId.startsWith("sbx_")
          ? eq(sandboxes.publicId, input.sandboxId)
          : eq(sandboxes.id, input.sandboxId),
        eq(sandboxes.organizationId, input.organizationId),
        eq(sandboxes.projectId, input.projectId),
      ),
    )
    .then((rows) => rows[0]);
  if (!sandbox) {
    throw new ApiError(404, "not_found", "sandbox not found");
  }
  return sandbox;
}

export async function listProjectSandboxes(db: MetalDb, userId: string, projectId: string) {
  const project = await getProject(db, userId, projectId);
  return db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.projectId, project.id))
    .orderBy(desc(sandboxes.createdAt));
}

export async function listScopedSandboxes(
  db: MetalDb,
  input: { organizationId: string; projectId: string; cursor?: string; limit: number },
) {
  const rows = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.organizationId, input.organizationId),
        eq(sandboxes.projectId, input.projectId),
      ),
    )
    .orderBy(desc(sandboxes.createdAt), desc(sandboxes.id));
  const start = input.cursor
    ? rows.findIndex((sandbox) => sandbox.publicId === input.cursor) + 1
    : 0;
  if (input.cursor && start === 0) {
    throw new ApiError(422, "validation_error", "invalid sandbox cursor");
  }
  const page = rows.slice(start, start + input.limit);
  return {
    rows: page,
    nextCursor: rows.length > start + input.limit ? (page.at(-1)?.publicId ?? null) : null,
  };
}

export async function requestSandboxPause(
  db: MetalDb,
  input: { sandboxId: string; organizationId: string; projectId: string },
) {
  return withTransaction(db, async (tx) => {
    const sandbox = await getSandbox(tx, input);
    const operation = await createOperation(tx, {
      organizationId: sandbox.organizationId,
      projectId: sandbox.projectId,
      sandboxId: sandbox.id,
      type: "sandbox_pause",
    });
    if (sandbox.status === "paused") {
      await tx
        .update(operations)
        .set({ state: "succeeded", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(operations.id, operation.id));
      return { sandbox, operation: { ...operation, state: "succeeded" as const } };
    }
    if (
      sandbox.provider === "blaxel" ||
      sandbox.provider === "cloudflare" ||
      sandbox.provider === "modal" ||
      sandbox.provider === "vercel"
    ) {
      throw new ApiError(
        409,
        "unsupported_operation",
        `${sandbox.provider} sandboxes do not support pause`,
      );
    }
    if (sandbox.status !== "ready" && sandbox.status !== "pausing") {
      throw new ApiError(409, "invalid_sandbox_state", "only ready sandboxes can be paused");
    }
    const [updated] =
      sandbox.status === "pausing"
        ? [sandbox]
        : await tx
            .update(sandboxes)
            .set({ status: "pausing", updatedAt: new Date() })
            .where(eq(sandboxes.id, sandbox.id))
            .returning();
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "sandbox.pause",
        dedupeKey: `sandbox:pause:${sandbox.id}`,
        payload: {
          job_type: "sandbox.pause",
          sandbox_id: sandbox.id,
          operation_id: operation.id,
        },
      })
      .onConflictDoNothing();
    return { sandbox: updated ?? sandbox, operation };
  });
}

export async function requestSandboxDeletion(
  db: MetalDb,
  input: { sandboxId: string; organizationId: string; projectId: string },
) {
  return withTransaction(db, async (tx) => {
    const sandbox = await getSandbox(tx, input);
    const operation = await createOperation(tx, {
      organizationId: sandbox.organizationId,
      projectId: sandbox.projectId,
      sandboxId: sandbox.id,
      type: "sandbox_destroy",
    });
    if (sandbox.status === "stopped" || sandbox.status === "deleted") {
      await tx
        .update(operations)
        .set({ state: "succeeded", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(operations.id, operation.id));
      return { sandbox, operation: { ...operation, state: "succeeded" as const } };
    }
    const [updated] = await tx
      .update(sandboxes)
      .set({ status: "stopping", updatedAt: new Date() })
      .where(eq(sandboxes.id, sandbox.id))
      .returning();
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "sandbox.destroy",
        dedupeKey: `sandbox:destroy:${sandbox.id}`,
        payload: {
          job_type: "sandbox.destroy",
          sandbox_id: sandbox.id,
          operation_id: operation.id,
        },
      })
      .onConflictDoUpdate({
        target: outboxJobs.dedupeKey,
        set: {
          payload: {
            job_type: "sandbox.destroy",
            sandbox_id: sandbox.id,
            operation_id: operation.id,
          },
          status: "pending",
          attemptCount: 0,
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          completedAt: null,
          updatedAt: new Date(),
        },
      });
    return { sandbox: updated ?? sandbox, operation };
  });
}

export async function requestSandboxResume(
  db: MetalDb,
  input: { sandboxId: string; organizationId: string; projectId: string },
) {
  return withTransaction(db, async (tx) => {
    const sandbox = await getSandbox(tx, input);
    if (!["codesandbox", "e2b", "freestyle", "northflank", "runloop"].includes(sandbox.provider)) {
      throw new ApiError(
        409,
        "capability_unsupported",
        `${sandbox.provider} sandboxes do not support resume`,
      );
    }
    if (sandbox.status !== "paused" && sandbox.status !== "resuming") {
      throw new ApiError(409, "invalid_sandbox_state", "only paused sandboxes can be resumed");
    }
    const operation = await createOperation(tx, {
      organizationId: sandbox.organizationId,
      projectId: sandbox.projectId,
      sandboxId: sandbox.id,
      type: "sandbox_resume",
    });
    const [updated] =
      sandbox.status === "resuming"
        ? [sandbox]
        : await tx
            .update(sandboxes)
            .set({ status: "resuming", updatedAt: new Date() })
            .where(eq(sandboxes.id, sandbox.id))
            .returning();
    await tx
      .insert(outboxJobs)
      .values({
        jobType: "sandbox.resume",
        dedupeKey: `sandbox:resume:${sandbox.id}`,
        payload: {
          job_type: "sandbox.resume",
          sandbox_id: sandbox.id,
          operation_id: operation.id,
        },
      })
      .onConflictDoNothing();
    return { sandbox: updated ?? sandbox, operation };
  });
}

export { requireMembership };
