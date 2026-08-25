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
  ListSandboxesQuerySchema,
  OpaqueIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  ProviderCredentialInputSchema,
  SandboxProviderSchema,
  SandboxIdSchema,
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
  listScopedSandboxes,
  listProjects,
  getSandbox,
  requestSandboxDeletion,
  requestSandboxPause,
  requestSandboxResume,
  updateProject,
} from "./services.js";
import { getOperationForPrincipal, listOperationEvents } from "./operation-service.js";
import {
  configureOrganizationProviderCredential,
  listOrganizationProviderCredentials,
  removeOrganizationProviderCredential,
} from "./provider-credentials.js";

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
  publicId?: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.publicId ?? `prj_${row.id.replaceAll("-", "")}`,
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
    project_id: `prj_${row.projectId.replaceAll("-", "")}`,
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

function serializeProviderCredential(row: {
  id: string;
  organizationId: string;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    provider: SandboxProviderSchema.parse(row.provider),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeSandbox(row: {
  id: string;
  publicId?: string;
  organizationId: string;
  projectId: string;
  provider: string;
  primaryProvider?: string;
  billingMode?: string;
  providerResourceId?: string | null;
  source?: Record<string, unknown>;
  resourceRequirements?: Record<string, unknown>;
  resolvedResources?: Record<string, unknown> | null;
  lifecycle?: Record<string, unknown>;
  regions?: string[];
  features?: Record<string, unknown>;
  network?: Record<string, unknown>;
  fallback?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  environment?: Record<string, string>;
  secretRefs?: Record<string, string>;
  metadata?: Record<string, string>;
  providerCostMicrousd: bigint | null;
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
  const state =
    row.status === "deleting" ? "stopping" : row.status === "deleted" ? "stopped" : row.status;
  return {
    id: row.publicId ?? `sbx_${row.id.replaceAll("-", "")}`,
    type: "sandbox" as const,
    project_id: `prj_${row.projectId.replaceAll("-", "")}`,
    provider:
      row.primaryProvider === "auto" && !row.providerResourceId
        ? null
        : (row.provider as
            | "blaxel"
            | "cloudflare"
            | "codesandbox"
            | "daytona"
            | "e2b"
            | "modal"
            | "northflank"
            | "runloop"
            | "vercel"),
    billing_mode: row.billingMode === "byok" ? ("byok" as const) : ("managed" as const),
    cost_microusd: row.providerCostMicrousd?.toString() ?? null,
    cost_updated_at: row.providerCostUpdatedAt?.toISOString() ?? null,
    state,
    state_reason: row.errorCode,
    requested: {
      provider: row.primaryProvider ?? row.provider,
      source:
        row.source && Object.keys(row.source).length
          ? row.source
          : { kind: "environment", environment: row.language, version: "legacy" },
      resources:
        row.resourceRequirements && Object.keys(row.resourceRequirements).length
          ? row.resourceRequirements
          : { vcpu: 1, memory_mb: 2048, architecture: "any" },
      lifecycle:
        row.lifecycle && Object.keys(row.lifecycle).length
          ? row.lifecycle
          : {
              runtime_timeout_seconds: 1800,
              on_runtime_timeout: "destroy",
              on_idle_timeout: "destroy",
            },
      regions: row.regions?.length ? row.regions : undefined,
      features: row.features && Object.keys(row.features).length ? row.features : undefined,
      network: row.network && Object.keys(row.network).length ? row.network : undefined,
      fallback: row.fallback && Object.keys(row.fallback).length ? row.fallback : undefined,
      provider_options:
        row.providerOptions && Object.keys(row.providerOptions).length
          ? row.providerOptions
          : undefined,
      environment:
        row.environment && Object.keys(row.environment).length ? row.environment : undefined,
      secret_refs:
        row.secretRefs && Object.keys(row.secretRefs).length ? row.secretRefs : undefined,
      metadata: row.metadata && Object.keys(row.metadata).length ? row.metadata : undefined,
    },
    resolved_resources: row.resolvedResources ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ready_at: row.readyAt?.toISOString() ?? null,
    paused_at: row.pausedAt?.toISOString() ?? null,
    stopped_at: row.deletedAt?.toISOString() ?? null,
    metadata: row.metadata && Object.keys(row.metadata).length ? row.metadata : undefined,
  };
}

function serializeOperation(row: {
  publicId: string;
  projectId: string;
  sandboxId: string;
  type: string;
  state: string;
  retryable: boolean;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: row.publicId,
    project_id: `prj_${row.projectId.replaceAll("-", "")}`,
    type: row.type,
    state: row.state,
    resource_type: "sandbox" as const,
    resource_id: `sbx_${row.sandboxId.replaceAll("-", "")}`,
    retryable: row.retryable,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

function serializeMutation(input: {
  sandbox: Parameters<typeof serializeSandbox>[0];
  operation: Parameters<typeof serializeOperation>[0];
}) {
  return {
    sandbox: serializeSandbox(input.sandbox),
    operation: serializeOperation(input.operation),
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
    methods: ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"],
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

  async function requireProjectScope(request: {
    headers: {
      authorization?: string;
      "x-metal-project-id"?: string | string[];
    };
  }) {
    const principal = await requireApiKeyPrincipal(request);
    const projectId = headerValue(request.headers["x-metal-project-id"]);
    if (!projectId) {
      throw new ApiError(400, "validation_error", "X-Metal-Project-ID is required");
    }
    const parsedProjectId = ProjectIdSchema.safeParse(projectId);
    if (!parsedProjectId.success) {
      throw new ApiError(422, "validation_error", "X-Metal-Project-ID must be a prj_* public ID");
    }
    if (parsedProjectId.data !== principal.projectPublicId) {
      throw new ApiError(403, "forbidden", "API key is scoped to another project");
    }
    return principal;
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

  app.get(
    `/${API_VERSION}/organizations/:organization_id/provider-credentials`,
    async (request) => {
      const principal = await requirePrincipal(request);
      const organizationId = OpaqueIdSchema.parse(
        (request.params as { organization_id: string }).organization_id,
      );
      const rows = await listOrganizationProviderCredentials(db.db, {
        userId: principal.userId,
        organizationId,
      });
      return { provider_credentials: rows.map(serializeProviderCredential) };
    },
  );

  app.put(
    `/${API_VERSION}/organizations/:organization_id/provider-credentials/:provider`,
    async (request, reply) => {
      const principal = await requirePrincipal(request);
      const params = request.params as { organization_id: string; provider: string };
      const organizationId = OpaqueIdSchema.parse(params.organization_id);
      const provider = SandboxProviderSchema.parse(params.provider);
      const parsed = ProviderCredentialInputSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.provider !== provider) {
        throw new ApiError(422, "validation_error", "invalid provider credential payload", {
          issues: parsed.success
            ? [{ path: ["provider"], message: "provider must match the request path" }]
            : parsed.error.issues,
        });
      }
      const result = await configureOrganizationProviderCredential(db.db, {
        userId: principal.userId,
        organizationId,
        credential: parsed.data,
      });
      return reply
        .status(result.created ? 201 : 200)
        .send(serializeProviderCredential(result.credential));
    },
  );

  app.delete(
    `/${API_VERSION}/organizations/:organization_id/provider-credentials/:provider`,
    async (request) => {
      const principal = await requirePrincipal(request);
      const params = request.params as { organization_id: string; provider: string };
      const organizationId = OpaqueIdSchema.parse(params.organization_id);
      const provider = SandboxProviderSchema.parse(params.provider);
      await removeOrganizationProviderCredential(db.db, {
        userId: principal.userId,
        organizationId,
        provider,
      });
      return { provider, deleted: true as const };
    },
  );

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
    const projectId = ProjectIdSchema.parse((request.params as { project_id: string }).project_id);
    return serializeProject(await getProject(db.db, principal.userId, projectId));
  });

  app.patch(`/${API_VERSION}/projects/:project_id`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = ProjectIdSchema.parse((request.params as { project_id: string }).project_id);
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
    const projectId = ProjectIdSchema.parse((request.params as { project_id: string }).project_id);
    const project = await deleteProject(db.db, {
      userId: principal.userId,
      projectId,
    });
    return { id: project.publicId, deleted: true as const };
  });

  app.post(`/${API_VERSION}/projects/:project_id/api-keys`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const projectId = ProjectIdSchema.parse((request.params as { project_id: string }).project_id);
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
    const projectId = ProjectIdSchema.parse((request.params as { project_id: string }).project_id);
    const rows = await listProjectApiKeys(db.db, {
      userId: principal.userId,
      projectId,
    });
    return { api_keys: rows.map(serializeApiKey) };
  });

  app.get(`/${API_VERSION}/projects/:project_id/sandboxes`, async (request) => {
    const principal = await requirePrincipal(request);
    const projectId = ProjectIdSchema.parse((request.params as { project_id: string }).project_id);
    const rows = await listProjectSandboxes(db.db, principal.userId, projectId);
    return { sandboxes: rows.map(serializeSandbox) };
  });

  app.post(`/${API_VERSION}/projects/:project_id/sandboxes/:sandbox_id/pause`, async (request) => {
    const principal = await requirePrincipal(request);
    const params = request.params as { project_id: string; sandbox_id: string };
    const projectId = ProjectIdSchema.parse(params.project_id);
    const sandboxId = SandboxIdSchema.parse(params.sandbox_id);
    const project = await getProject(db.db, principal.userId, projectId);
    return serializeMutation(
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
    const projectId = ProjectIdSchema.parse(params.project_id);
    const sandboxId = SandboxIdSchema.parse(params.sandbox_id);
    const project = await getProject(db.db, principal.userId, projectId);
    return serializeMutation(
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
    const projectId = ProjectIdSchema.parse(params.project_id);
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
    const projectId = ProjectIdSchema.parse(params.project_id);
    const apiKeyId = OpaqueIdSchema.parse(params.api_key_id);
    const row = await deleteProjectApiKey(db.db, {
      userId: principal.userId,
      projectId,
      apiKeyId,
    });
    return { id: row.id, deleted: true as const };
  });

  app.get(`/${API_VERSION}/sandboxes`, async (request) => {
    const principal = await requireProjectScope(request);
    const parsed = ListSandboxesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid sandbox list query", {
        issues: parsed.error.issues,
      });
    }
    const page = await listScopedSandboxes(db.db, {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return {
      sandboxes: page.rows.map(serializeSandbox),
      next_cursor: page.nextCursor,
    };
  });

  app.post(`/${API_VERSION}/sandboxes`, async (request, reply) => {
    const principal = await requireProjectScope(request);
    const parsed = CreateSandboxRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, "validation_error", "invalid sandbox payload", {
        issues: parsed.error.issues,
      });
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
        const mutation = await createSandbox(tx, {
          organizationId: principal.organizationId,
          projectId: principal.projectId,
          actorId: principal.keyId,
          request: parsed.data,
        });
        return {
          status: 202,
          body: {
            sandbox: serializeSandbox(mutation.sandbox),
            operation: serializeOperation(mutation.operation),
          },
        };
      },
    );
    const operationId =
      typeof result.body === "object" &&
      result.body !== null &&
      "operation" in result.body &&
      typeof result.body.operation === "object" &&
      result.body.operation !== null &&
      "id" in result.body.operation
        ? String(result.body.operation.id)
        : undefined;
    if (operationId) {
      reply.header("location", `/${API_VERSION}/operations/${operationId}`);
    }
    return reply.status(result.status).send(result.body);
  });

  app.get(`/${API_VERSION}/sandboxes/:sandbox_id`, async (request) => {
    const principal = await requireProjectScope(request);
    const sandboxId = SandboxIdSchema.parse((request.params as { sandbox_id: string }).sandbox_id);
    return serializeSandbox(
      await getSandbox(db.db, {
        sandboxId,
        organizationId: principal.organizationId,
        projectId: principal.projectId,
      }),
    );
  });

  app.post(`/${API_VERSION}/sandboxes/:sandbox_id/actions/pause`, async (request, reply) => {
    const principal = await requireProjectScope(request);
    const sandboxId = SandboxIdSchema.parse((request.params as { sandbox_id: string }).sandbox_id);
    const mutation = serializeMutation(
      await requestSandboxPause(db.db, {
        sandboxId,
        organizationId: principal.organizationId,
        projectId: principal.projectId,
      }),
    );
    reply.header("location", `/${API_VERSION}/operations/${mutation.operation.id}`);
    return reply.status(202).send(mutation);
  });

  app.post(`/${API_VERSION}/sandboxes/:sandbox_id/actions/resume`, async (request, reply) => {
    const principal = await requireProjectScope(request);
    const sandboxId = SandboxIdSchema.parse((request.params as { sandbox_id: string }).sandbox_id);
    const mutation = serializeMutation(
      await requestSandboxResume(db.db, {
        sandboxId,
        organizationId: principal.organizationId,
        projectId: principal.projectId,
      }),
    );
    reply.header("location", `/${API_VERSION}/operations/${mutation.operation.id}`);
    return reply.status(202).send(mutation);
  });

  app.delete(`/${API_VERSION}/sandboxes/:sandbox_id`, async (request, reply) => {
    const principal = await requireProjectScope(request);
    const sandboxId = SandboxIdSchema.parse((request.params as { sandbox_id: string }).sandbox_id);
    const mutation = serializeMutation(
      await requestSandboxDeletion(db.db, {
        sandboxId,
        organizationId: principal.organizationId,
        projectId: principal.projectId,
      }),
    );
    reply.header("location", `/${API_VERSION}/operations/${mutation.operation.id}`);
    return reply.status(202).send(mutation);
  });

  app.get(`/${API_VERSION}/operations/:operation_id`, async (request) => {
    const principal = await requireApiKeyPrincipal(request);
    const operationId = OperationIdSchema.parse(
      (request.params as { operation_id: string }).operation_id,
    );
    return serializeOperation(await getOperationForPrincipal(db.db, principal.keyId, operationId));
  });

  app.get(`/${API_VERSION}/operations/:operation_id/events`, async (request, reply) => {
    const principal = await requireApiKeyPrincipal(request);
    const operationId = OperationIdSchema.parse(
      (request.params as { operation_id: string }).operation_id,
    );
    const operation = await getOperationForPrincipal(db.db, principal.keyId, operationId);
    const header = request.headers["last-event-id"];
    if (header !== undefined && (typeof header !== "string" || !/^\d+$/.test(header))) {
      throw new ApiError(422, "validation_error", "Last-Event-ID must be an event sequence");
    }
    const after = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : 0;
    const events = await listOperationEvents(db.db, operation.id, after);
    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-cache");
    return events
      .map(
        (event) =>
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({
            sequence: event.sequence,
            operation_id: operation.publicId,
            type: event.type,
            occurred_at: event.occurredAt.toISOString(),
            data: event.data,
          })}\n\n`,
      )
      .join("");
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
