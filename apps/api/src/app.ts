import { ZodError } from "zod";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { API_SEMVER, API_VERSION, buildOpenApiDocument } from "@openmetal/contracts";
import {
  CreateOrganizationRequestSchema,
  CreateProjectRequestSchema,
  ListEventsQuerySchema,
  OpaqueIdSchema,
} from "@openmetal/contracts";
import { createDatabase, type MetalDatabase } from "@openmetal/db";
import { createLogger } from "@openmetal/logger";
import { CursorError } from "@openmetal/events";
import { createAuthVerifier, type Principal } from "./auth.js";
import { beginIdempotency, completeIdempotency } from "./idempotency.js";
import { ApiError, sendError } from "./errors.js";
import { loadApiEnv, type ApiEnv } from "./env.js";
import { listProjectEvents } from "./event-service.js";
import {
  createOrganization,
  createProject,
  getOrganization,
  getProject,
  listOrganizations,
  listProjects,
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

  async function requirePrincipal(request: { headers: { authorization?: string } }) {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    return verifier.verify(token);
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
    const replay = await beginIdempotency(db.db, {
      principalId: principal.userId,
      operation: "organizations.create",
      key,
      body: parsed.data,
    });
    if (replay?.replay) {
      return reply.status(replay.replay.status).send(replay.replay.body);
    }
    try {
      const organization = serializeOrg(
        await createOrganization(db.db, {
          userId: principal.userId,
          name: parsed.data.name,
          slug: parsed.data.slug,
        }),
      );
      await completeIdempotency(db.db, {
        principalId: principal.userId,
        operation: "organizations.create",
        key,
        status: 201,
        body: organization,
      });
      return reply.status(201).send(organization);
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
    const replay = await beginIdempotency(db.db, {
      principalId: principal.userId,
      operation: `projects.create:${organizationId}`,
      key,
      body: parsed.data,
    });
    if (replay?.replay) {
      return reply.status(replay.replay.status).send(replay.replay.body);
    }
    try {
      const project = serializeProject(
        await createProject(db.db, {
          userId: principal.userId,
          organizationId,
          name: parsed.data.name,
          slug: parsed.data.slug,
        }),
      );
      await completeIdempotency(db.db, {
        principalId: principal.userId,
        operation: `projects.create:${organizationId}`,
        key,
        status: 201,
        body: project,
      });
      return reply.status(201).send(project);
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
