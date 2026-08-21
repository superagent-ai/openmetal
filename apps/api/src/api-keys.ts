import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { projectApiKeys, projects, type MetalDb } from "@openmetal/db";
import { ApiError } from "./errors.js";
import { getProject, requireMembership } from "./services.js";

const EXPIRATION_MS = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "180d": 180 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
} as const;

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createProjectApiKey(
  db: MetalDb,
  input: {
    userId: string;
    projectId: string;
    name: string;
    expiresIn: keyof typeof EXPIRATION_MS | null;
  },
) {
  const project = await getProject(db, input.userId, input.projectId);
  await requireMembership(db, input.userId, project.organizationId, ["owner", "admin"]);

  const key = `metal_sk_${randomBytes(32).toString("base64url")}`;
  const prefix = key.slice(0, 20);
  const [row] = await db
    .insert(projectApiKeys)
    .values({
      projectId: project.id,
      name: input.name,
      prefix,
      secretHash: hashKey(key),
      createdBy: input.userId,
      expiresAt: input.expiresIn ? new Date(Date.now() + EXPIRATION_MS[input.expiresIn]) : null,
    })
    .returning();
  if (!row) {
    throw new ApiError(500, "internal_error", "failed to create API key");
  }
  return { row, key };
}

export async function listProjectApiKeys(
  db: MetalDb,
  input: { userId: string; projectId: string },
) {
  await getProject(db, input.userId, input.projectId);
  return db
    .select()
    .from(projectApiKeys)
    .where(and(eq(projectApiKeys.projectId, input.projectId), isNull(projectApiKeys.deletedAt)));
}

export async function revokeProjectApiKey(
  db: MetalDb,
  input: { userId: string; projectId: string; apiKeyId: string },
) {
  const project = await getProject(db, input.userId, input.projectId);
  await requireMembership(db, input.userId, project.organizationId, ["owner", "admin"]);
  const [row] = await db
    .update(projectApiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(projectApiKeys.id, input.apiKeyId),
        eq(projectApiKeys.projectId, input.projectId),
        isNull(projectApiKeys.revokedAt),
        isNull(projectApiKeys.deletedAt),
      ),
    )
    .returning();
  if (!row) {
    throw new ApiError(404, "not_found", "API key not found");
  }
  return row;
}

export async function deleteProjectApiKey(
  db: MetalDb,
  input: { userId: string; projectId: string; apiKeyId: string },
) {
  const project = await getProject(db, input.userId, input.projectId);
  await requireMembership(db, input.userId, project.organizationId, ["owner", "admin"]);
  const [row] = await db
    .update(projectApiKeys)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(projectApiKeys.id, input.apiKeyId),
        eq(projectApiKeys.projectId, input.projectId),
        isNotNull(projectApiKeys.revokedAt),
        isNull(projectApiKeys.deletedAt),
      ),
    )
    .returning({ id: projectApiKeys.id });
  if (!row) {
    throw new ApiError(409, "api_key_must_be_revoked", "revoke the API key before deleting it");
  }
  return row;
}

export async function authenticateProjectApiKey(db: MetalDb, key: string) {
  if (!key.startsWith("metal_sk_")) {
    throw new ApiError(401, "unauthenticated", "invalid API key");
  }
  const [result] = await db
    .select({
      keyId: projectApiKeys.id,
      projectId: projectApiKeys.projectId,
      organizationId: projects.organizationId,
      expiresAt: projectApiKeys.expiresAt,
    })
    .from(projectApiKeys)
    .innerJoin(projects, eq(projects.id, projectApiKeys.projectId))
    .where(
      and(
        eq(projectApiKeys.secretHash, hashKey(key)),
        isNull(projectApiKeys.revokedAt),
        isNull(projectApiKeys.deletedAt),
        isNull(projects.deletedAt),
      ),
    );
  if (!result || (result.expiresAt && result.expiresAt <= new Date())) {
    throw new ApiError(401, "unauthenticated", "invalid API key");
  }
  await db
    .update(projectApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(projectApiKeys.id, result.keyId));
  return result;
}
