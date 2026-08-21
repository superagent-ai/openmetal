import { ZodError } from "zod";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { API_SEMVER, API_VERSION, buildOpenApiDocument } from "@openmetal/contracts";
import {
  CreateOrganizationRequestSchema,
  CreateProjectApiKeyRequestSchema,
  CreateProjectRequestSchema,
  CreateSandboxRequestSchema,
  ListEventsQuerySchema,
  OpaqueIdSchema,
  UpdateProjectRequestSchema,
} from "@openmetal/contracts";
import { createDatabase, type MetalDatabase } from "@openmetal/db";
import { createLogger } from "@openmetal/logger";
import { CursorError } from "@openmetal/events";
import { createAuthVerifier, type Principal } from "./auth.js";
import {
  authenticateProjectApiKey,
  createProjectApiKey,
  deleteProjectApiKey,
  listProjectApiKeys,
  revokeProjectApiKey,
} from "./api-keys.js";
import { executeIdempotent } from "./idempotency.js";
import { ApiError, sendError } from "./errors.js";
import { loadApiEnv, type ApiEnv } from "./env.js";
import { listProjectEvents } from "./event-service.js";
import {
  createOrganization,
  createProject,
  createSandbox,
  deleteProject,
  getOrganization,
  getProject,
  listOrganizations,
  listProjectSandboxes,
  listProjects,
  getSandbox,
  requestSandboxDeletion,
  requestSandboxPause,
  updateProject,
} from "./services.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function serializeOrg(row: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeProject(row: {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeApiKey(row: {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  deletedAt: Date | null;
}) {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

function serializeSandbox(row: {
  id: string;
  organizationId: string;
  projectId: string;
  provider: string;
  providerCostMicrousd: bigint | null;
  providerCostMeasuredThrough: Date | null;
  providerCostUpdatedAt: Date | null;
  status: string;
  image: string | null;
  language: string;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  pausedAt: Date | null;
  deletedAt: Date | null;
}) {
  return {
    id: row.id,
    type: "sandbox" as const,
    organization_id: row.organizationId,
    project_id: row.projectId,
    provider: row.provider as "daytona" | "e2b" | "modal",
    provider_cost_microusd: row.providerCostMicrousd?.toString() ?? null,
    provider_cost_measured_through: row.providerCostMeasuredThrough?.toISOString() ?? null,
    provider_cost_updated_at: row.providerCostUpdatedAt?.toISOString() ?? null,
    status: row.status,
    image: row.image,
    language: row.language,
    error_code: row.errorCode,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ready_at: row.readyAt?.toISOString() ?? null,
    paused_at: row.pausedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

export async function buildApp(env: ApiEnv = loadApiEnv(), database?: MetalDatabase) {
  const logger = createLogger({
    service: "api",
    environment: env.METAL_ENVIRONMENT,
    level: env.LOG_LEVEL,
  });
  const db = database ?? createDatabase({ DATABASE_URL: env.DATABASE_URL });
  const verifier = createAuthVerifier(env);
  const app = Fastify({
    logger: false,
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      return typeof header === "string" && header.length > 0 ? header : crypto.randomUUID();
    },
    requestTimeout: env.API_REQUEST_TIMEOUT_MS,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ALLOWED_ORIGINS.split(",").map((value) => value.trim()),
    credentials: true,
    methods: ["DELETE", "GET", "HEAD", "PATCH", "POST"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"],
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    logger.info({
      request_id: request.id,
      method: request.method,
      path: request.url,
      status_code: reply.statusCode,
      duration_ms: reply.elapsedTime,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return sendError(request, reply, error);
    }
    if (error instanceof CursorError || error instanceof ZodError) {
      return sendError(request, reply, new ApiError(422, "validation_error", error.message));
    }
    logger.error({ err: error, request_id: request.id });
    return sendError(request, reply, new ApiError(500, "internal_error", "internal error"));
  });
  app.setNotFoundHandler((request, reply) => {
    return sendError(request, reply, new ApiError(404, "not_found", "route not found"));
  });

  async function requirePrincipal(request: { headers: { authorization?: string } }) {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    return verifier.verify(token);
  }

  async function requireApiKeyPrincipal(request: { headers: { authorization?: string } }) {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token?.startsWith("metal_sk_")) {
      throw new ApiError(401, "unauthenticated", "project API key required");
    }
    return authenticateProjectApiKey(db.db, token);
  }

  app.get("/health", async () => ({ status: "ok" as const }));

  app.get("/ready", async (_request, reply) => {
    const databaseOk = await db.ready();
    const body = {
      status: databaseOk ? ("ready" as const) : ("not_ready" as const),
      checks: { database: databaseOk ? ("ok" as const) : ("error" as const) },
    };
    return reply.status(databaseOk ? 200 : 503).send(body);
  });

  app.get(`/${API_VERSION}/meta`, async () => ({
    name: "metal" as const,
    version: API_SEMVER,
    api_version: API_VERSION,
    semver: API_SEMVER,
  }));

  app.get(`/${API_VERSION}/openapi.json`, async () => buildOpenApiDocument());

  app.post(`/${API_VERSION}/organizations`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const parsed = CreateOrganizationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid organization payload", {
        issues: parsed.error.issues,
      });
    }
    const key = headerValue(request.headers["idempotency-key"]);
    try {
      const result = await executeIdempotent(
        db.db,
        {
          principalId: principal.userId,
          operation: "organizations.create",
          key,
          body: parsed.data,
        },
        async (tx) => {
          const organization = serializeOrg(
            await createOrganization(tx, {
              userId: principal.userId,
              name: parsed.data.name,
              slug: parsed.data.slug,
            }),
          );
          return { status: 201, body: organization };
        },
      );
      return reply.status(result.status).send(result.body);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "conflict", "organization slug already exists");
      }
      throw error;
    }
  });

  app.get(`/${API_VERSION}/organizations`, async (request) => {
    const principal = await requirePrincipal(request);
    const rows = await listOrganizations(db.db, principal.userId);
    return { organizations: rows.map(serializeOrg) };
  });

  app.get(`/${API_VERSION}/organizations/:organization_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const organizationId = OpaqueIdSchema.parse(
      (request.params as { organization_id: string }).organization_id,
    );
    return serializeOrg(await getOrganization(db.db, principal.userId, organizationId));
  });

  app.post(`/${API_VERSION}/organizations/:organization_id/projects`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const organizationId = OpaqueIdSchema.parse(
      (request.params as { organization_id: string }).organization_id,
    );
    const parsed = CreateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid project payload", {
        issues: parsed.error.issues,
      });
    }
    const key = headerValue(request.headers["idempotency-key"]);
    try {
      const result = await executeIdempotent(
        db.db,
        {
          principalId: principal.userId,
          operation: `projects.create:${organizationId}`,
          key,
          body: parsed.data,
        },
        async (tx) => {
          const project = serializeProject(
            await createProject(tx, {
              userId: principal.userId,
              organizationId,
              name: parsed.data.name,
              slug: parsed.data.slug,
            }),
          );
          return { status: 201, body: project };
        },
      );
      return reply.status(result.status).send(result.body);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "conflict", "project slug already exists");
      }
      throw error;
    }
  });

  app.get(`/${API_VERSION}/organizations/:organization_id/projects`, async (request) => {
    const principal = await requirePrincipal(request);
    const organizationId = OpaqueIdSchema.parse(
      (request.params as { organization_id: string }).organization_id,
    );
    const rows = await listProjects(db.db, principal.userId, organizationId);
    return { projects: rows.map(serializeProject) };
  });

  app.get(`/${API_VERSION}/projects/:project_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = OpaqueIdSchema.parse((request.params as { project_id: string }).project_id);
    return serializeProject(await getProject(db.db, principal.userId, projectId));
  });

  app.patch(`/${API_VERSION}/projects/:project_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = OpaqueIdSchema.parse((request.params as { project_id: string }).project_id);
    const parsed = UpdateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid project payload", {
        issues: parsed.error.issues,
      });
    }

    try {
      return serializeProject(
        await updateProject(db.db, {
          userId: principal.userId,
          projectId,
          name: parsed.data.name,
          slug: parsed.data.slug,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "conflict", "project slug already exists");
      }
      throw error;
    }
  });

  app.delete(`/${API_VERSION}/projects/:project_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = OpaqueIdSchema.parse((request.params as { project_id: string }).project_id);
    const project = await deleteProject(db.db, {
      userId: principal.userId,
      projectId,
    });
    return { id: project.id, deleted: true as const };
  });

  app.post(`/${API_VERSION}/projects/:project_id/api-keys`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const projectId = OpaqueIdSchema.parse((request.params as { project_id: string }).project_id);
    const parsed = CreateProjectApiKeyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid API key payload", {
        issues: parsed.error.issues,
      });
    }
    const created = await createProjectApiKey(db.db, {
      userId: principal.userId,
      projectId,
      name: parsed.data.name,
      expiresIn: parsed.data.expires_in,
    });
    return reply.status(201).send({
      api_key: serializeApiKey(created.row),
      key: created.key,
    });
  });

  app.get(`/${API_VERSION}/projects/:project_id/api-keys`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = OpaqueIdSchema.parse((request.params as { project_id: string }).project_id);
    const rows = await listProjectApiKeys(db.db, {
      userId: principal.userId,
      projectId,
    });
    return { api_keys: rows.map(serializeApiKey) };
  });

  app.get(`/${API_VERSION}/projects/:project_id/sandboxes`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = OpaqueIdSchema.parse((request.params as { project_id: string }).project_id);
    const rows = await listProjectSandboxes(db.db, principal.userId, projectId);
    return { sandboxes: rows.map(serializeSandbox) };
  });

  app.post(`/${API_VERSION}/projects/:project_id/sandboxes/:sandbox_id/pause`, async (request) => {
    const principal = await requirePrincipal(request);
    const params = request.params as { project_id: string; sandbox_id: string };
    const projectId = OpaqueIdSchema.parse(params.project_id);
    const sandboxId = OpaqueIdSchema.parse(params.sandbox_id);
    const project = await getProject(db.db, principal.userId, projectId);
    return serializeSandbox(
      await requestSandboxPause(db.db, {
        sandboxId,
        organizationId: project.organizationId,
        projectId,
      }),
    );
  });

  app.delete(`/${API_VERSION}/projects/:project_id/sandboxes/:sandbox_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const params = request.params as { project_id: string; sandbox_id: string };
    const projectId = OpaqueIdSchema.parse(params.project_id);
    const sandboxId = OpaqueIdSchema.parse(params.sandbox_id);
    const project = await getProject(db.db, principal.userId, projectId);
    return serializeSandbox(
      await requestSandboxDeletion(db.db, {
        sandboxId,
        organizationId: project.organizationId,
        projectId,
      }),
    );
  });

  app.post(`/${API_VERSION}/projects/:project_id/api-keys/:api_key_id/revoke`, async (request) => {
    const principal = await requirePrincipal(request);
    const params = request.params as { project_id: string; api_key_id: string };
    const projectId = OpaqueIdSchema.parse(params.project_id);
    const apiKeyId = OpaqueIdSchema.parse(params.api_key_id);
    const row = await revokeProjectApiKey(db.db, {
      userId: principal.userId,
      projectId,
      apiKeyId,
    });
    return serializeApiKey(row);
  });

  app.delete(`/${API_VERSION}/projects/:project_id/api-keys/:api_key_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const params = request.params as { project_id: string; api_key_id: string };
    const projectId = OpaqueIdSchema.parse(params.project_id);
    const apiKeyId = OpaqueIdSchema.parse(params.api_key_id);
    const row = await deleteProjectApiKey(db.db, {
      userId: principal.userId,
      projectId,
      apiKeyId,
    });
    return { id: row.id, deleted: true as const };
  });

  app.post(`/${API_VERSION}/sandboxes`, async (request, reply) => {
    const principal = await requireApiKeyPrincipal(request);
    const parsed = CreateSandboxRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid sandbox payload", {
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.project_id && parsed.data.project_id !== principal.projectId) {
      throw new ApiError(403, "forbidden", "API key is scoped to another project");
    }
    const key = headerValue(request.headers["idempotency-key"]);
    if (!key) {
      throw new ApiError(400, "idempotency_key_required", "Idempotency-Key is required");
    }
    const result = await executeIdempotent(
      db.db,
      {
        principalId: principal.keyId,
        operation: `sandboxes.create:${principal.projectId}`,
        key,
        body: parsed.data,
      },
      async (tx) => {
        const sandbox = await createSandbox(tx, {
          organizationId: principal.organizationId,
          projectId: principal.projectId,
          actorId: principal.keyId,
          provider: parsed.data.provider,
          image: parsed.data.image,
          language: parsed.data.language,
          ttlMinutes: parsed.data.ttl_minutes,
        });
        return { status: 202, body: serializeSandbox(sandbox) };
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.get(`/${API_VERSION}/sandboxes/:sandbox_id`, async (request) => {
    const principal = await requireApiKeyPrincipal(request);
    const sandboxId = OpaqueIdSchema.parse((request.params as { sandbox_id: string }).sandbox_id);
    return serializeSandbox(
      await getSandbox(db.db, {
        sandboxId,
        organizationId: principal.organizationId,
        projectId: principal.projectId,
      }),
    );
  });

  app.delete(`/${API_VERSION}/sandboxes/:sandbox_id`, async (request) => {
    const principal = await requireApiKeyPrincipal(request);
    const sandboxId = OpaqueIdSchema.parse((request.params as { sandbox_id: string }).sandbox_id);
    return serializeSandbox(
      await requestSandboxDeletion(db.db, {
        sandboxId,
        organizationId: principal.organizationId,
        projectId: principal.projectId,
      }),
    );
  });

  app.get(`/${API_VERSION}/events`, async (request) => {
    const principal = await requirePrincipal(request);
    const parsed = ListEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid event query", {
        issues: parsed.error.issues,
      });
    }
    return listProjectEvents(db.db, {
      userId: principal.userId,
      projectId: parsed.data.project_id,
      after: parsed.data.after,
      limit: parsed.data.limit,
    });
  });

  app.addHook("onClose", async () => {
    await db.shutdown();
  });

  return { app, database: db };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "23505",
  );
}
