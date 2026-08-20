import { z } from "zod";
import { API_SEMVER, API_VERSION } from "./primitives.js";
import { ErrorEnvelopeSchema } from "./errors.js";
import { ApiMetadataResponseSchema, HealthResponseSchema, ReadinessResponseSchema } from "./ops.js";
import {
  CreateOrganizationRequestSchema,
  OrganizationListResponseSchema,
  OrganizationSchema,
} from "./organizations.js";
import {
  CreateProjectRequestSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
} from "./projects.js";
import { CursorEventPageSchema, ListEventsQuerySchema } from "./events.js";

const json = <T extends z.ZodType>(schema: T) =>
  z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;

export function buildOpenApiDocument(): Record<string, unknown> {
  const errorResponse = {
    description: "Stable Metal error envelope",
    content: {
      "application/json": {
        schema: json(ErrorEnvelopeSchema),
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Metal API",
      version: API_SEMVER,
      description: `Superagent Metal control plane ${API_VERSION}. Milestone 1 product API.`,
    },
    servers: [{ url: "/", description: "Configured Metal API origin" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          tags: ["ops"],
          responses: {
            "200": {
              description: "Process is alive",
              content: { "application/json": { schema: json(HealthResponseSchema) } },
            },
          },
        },
      },
      "/ready": {
        get: {
          operationId: "getReady",
          tags: ["ops"],
          responses: {
            "200": {
              description: "Dependencies are ready",
              content: { "application/json": { schema: json(ReadinessResponseSchema) } },
            },
            "503": {
              description: "Dependencies are not ready",
              content: { "application/json": { schema: json(ReadinessResponseSchema) } },
            },
          },
        },
      },
      "/v1/meta": {
        get: {
          operationId: "getMeta",
          tags: ["ops"],
          responses: {
            "200": {
              description: "API metadata",
              content: { "application/json": { schema: json(ApiMetadataResponseSchema) } },
            },
          },
        },
      },
      "/v1/organizations": {
        get: {
          operationId: "listOrganizations",
          tags: ["organizations"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Organizations for the authenticated principal",
              content: { "application/json": { schema: json(OrganizationListResponseSchema) } },
            },
            "401": errorResponse,
          },
        },
        post: {
          operationId: "createOrganization",
          tags: ["organizations"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: json(CreateOrganizationRequestSchema) } },
          },
          responses: {
            "201": {
              description: "Organization created",
              content: { "application/json": { schema: json(OrganizationSchema) } },
            },
            "401": errorResponse,
            "409": errorResponse,
            "422": errorResponse,
          },
        },
      },
      "/v1/organizations/{organization_id}": {
        get: {
          operationId: "getOrganization",
          tags: ["organizations"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "organization_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "Organization",
              content: { "application/json": { schema: json(OrganizationSchema) } },
            },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/organizations/{organization_id}/projects": {
        get: {
          operationId: "listProjects",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "organization_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "Projects in the organization",
              content: { "application/json": { schema: json(ProjectListResponseSchema) } },
            },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
        post: {
          operationId: "createProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "organization_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: json(CreateProjectRequestSchema) } },
          },
          responses: {
            "201": {
              description: "Project created",
              content: { "application/json": { schema: json(ProjectSchema) } },
            },
            "401": errorResponse,
            "403": errorResponse,
            "409": errorResponse,
            "422": errorResponse,
          },
        },
      },
      "/v1/projects/{project_id}": {
        patch: {
          operationId: "updateProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "project_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: json(UpdateProjectRequestSchema) } },
          },
          responses: {
            "200": {
              description: "Project updated",
              content: { "application/json": { schema: json(ProjectSchema) } },
            },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "422": errorResponse,
          },
        },
        delete: {
          operationId: "deleteProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "project_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "Project deleted",
              content: {
                "application/json": {
                  schema: json(z.object({ id: z.string(), deleted: z.literal(true) })),
                },
              },
            },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
        get: {
          operationId: "getProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "project_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "Project",
              content: { "application/json": { schema: json(ProjectSchema) } },
            },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/events": {
        get: {
          operationId: "listEvents",
          tags: ["events"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            { name: "after", in: "query", required: false, schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
          ],
          responses: {
            "200": {
              description: "Durable event page",
              content: { "application/json": { schema: json(CursorEventPageSchema) } },
            },
            "401": errorResponse,
            "403": errorResponse,
            "422": errorResponse,
          },
        },
      },
    },
  };
}

export const OpenApiQueryReference = ListEventsQuerySchema;
