import { z } from "zod";
import {
  CreateProjectApiKeyRequestSchema,
  CreateProjectApiKeyResponseSchema,
  ProjectApiKeyDeleteResponseSchema,
  ProjectApiKeyListResponseSchema,
  ProjectApiKeySchema,
} from "./api-keys.js";
import { ErrorEnvelopeSchema } from "./errors.js";
import { CursorEventPageSchema, ListEventsQuerySchema } from "./events.js";
import { OperationEventSchema, OperationSchema } from "./operations.js";
import { ApiMetadataResponseSchema, HealthResponseSchema, ReadinessResponseSchema } from "./ops.js";
import {
  CreateOrganizationInvitationRequestSchema,
  OrganizationInvitationRevokeResponseSchema,
  OrganizationInvitationSchema,
  OrganizationMemberDeleteResponseSchema,
  OrganizationMemberSchema,
  OrganizationMembersResponseSchema,
  UpdateOrganizationRoleRequestSchema,
} from "./members.js";
import {
  CreateOrganizationRequestSchema,
  OrganizationListResponseSchema,
  OrganizationSchema,
} from "./organizations.js";
import {
  ConfiguredProviderCredentialSchema,
  ProviderCredentialDeleteResponseSchema,
  ProviderCredentialInputSchema,
  ProviderCredentialListResponseSchema,
} from "./provider-credentials.js";
import { API_SEMVER, API_VERSION, ProjectIdSchema } from "./primitives.js";
import {
  CreateProjectRequestSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
} from "./projects.js";
import {
  CreateSandboxRequestSchema,
  ProjectSandboxListResponseSchema,
  SandboxListResponseSchema,
  SandboxMutationSchema,
  SandboxSchema,
} from "./sandboxes.js";
import {
  BillingCheckoutResponseSchema,
  BillingQuoteSchema,
  BillingSetupResponseSchema,
  CreateBillingCheckoutRequestSchema,
  OrganizationBillingSchema,
  UpdateAutoTopupRequestSchema,
} from "./billing.js";

type OpenApiObject = Record<string, unknown>;

function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== "object") return value;
  const input = value as OpenApiObject;
  const output: OpenApiObject = {};
  for (const [key, child] of Object.entries(input)) {
    if (key === "$schema") continue;
    if (key === "pattern" && (input.format === "date-time" || input.format === "uuid")) {
      continue;
    }
    output[key] = cleanSchema(child);
  }
  return output;
}

const json = <T extends z.ZodType>(schema: T) =>
  cleanSchema(z.toJSONSchema(schema, { target: "draft-2020-12" })) as OpenApiObject;

const ref = (name: string): OpenApiObject => ({
  $ref: `#/components/schemas/${name}`,
});
const parameterRef = (name: string): OpenApiObject => ({
  $ref: `#/components/parameters/${name}`,
});
const jsonContent = (name: string): OpenApiObject => ({
  "application/json": { schema: ref(name) },
});
const response = (description: string, schemaName: string): OpenApiObject => ({
  description,
  content: jsonContent(schemaName),
});
const errorResponse = (description: string): OpenApiObject => ({
  description,
  content: jsonContent("Error"),
});

const ProjectDeleteResponseSchema = z.object({
  id: ProjectIdSchema,
  deleted: z.literal(true),
});

export function buildOpenApiDocument(): OpenApiObject {
  return {
    openapi: "3.1.0",
    info: {
      title: "Metal API",
      version: API_SEMVER,
      description: `Superagent Metal control plane ${API_VERSION}.`,
    },
    servers: [{ url: "/", description: "Configured Metal API origin" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
      schemas: {
        Error: json(ErrorEnvelopeSchema),
        HealthResponse: json(HealthResponseSchema),
        ReadinessResponse: json(ReadinessResponseSchema),
        ApiMetadataResponse: json(ApiMetadataResponseSchema),
        Organization: json(OrganizationSchema),
        OrganizationListResponse: json(OrganizationListResponseSchema),
        CreateOrganizationRequest: json(CreateOrganizationRequestSchema),
        OrganizationMember: json(OrganizationMemberSchema),
        OrganizationInvitation: json(OrganizationInvitationSchema),
        OrganizationMembersResponse: json(OrganizationMembersResponseSchema),
        CreateOrganizationInvitationRequest: json(CreateOrganizationInvitationRequestSchema),
        UpdateOrganizationRoleRequest: json(UpdateOrganizationRoleRequestSchema),
        OrganizationMemberDeleteResponse: json(OrganizationMemberDeleteResponseSchema),
        OrganizationInvitationRevokeResponse: json(OrganizationInvitationRevokeResponseSchema),
        ProviderCredentialInput: json(ProviderCredentialInputSchema),
        ConfiguredProviderCredential: json(ConfiguredProviderCredentialSchema),
        ProviderCredentialListResponse: json(ProviderCredentialListResponseSchema),
        ProviderCredentialDeleteResponse: json(ProviderCredentialDeleteResponseSchema),
        Project: json(ProjectSchema),
        ProjectListResponse: json(ProjectListResponseSchema),
        CreateProjectRequest: json(CreateProjectRequestSchema),
        UpdateProjectRequest: json(UpdateProjectRequestSchema),
        ProjectDeleteResponse: json(ProjectDeleteResponseSchema),
        ProjectApiKey: json(ProjectApiKeySchema),
        CreateProjectApiKeyRequest: json(CreateProjectApiKeyRequestSchema),
        CreateProjectApiKeyResponse: json(CreateProjectApiKeyResponseSchema),
        ProjectApiKeyListResponse: json(ProjectApiKeyListResponseSchema),
        ProjectApiKeyDeleteResponse: json(ProjectApiKeyDeleteResponseSchema),
        CreateSandboxRequest: json(CreateSandboxRequestSchema),
        Sandbox: json(SandboxSchema),
        SandboxMutation: json(SandboxMutationSchema),
        ProjectSandboxListResponse: json(ProjectSandboxListResponseSchema),
        SandboxListResponse: json(SandboxListResponseSchema),
        Operation: json(OperationSchema),
        OperationEvent: json(OperationEventSchema),
        CursorEventPage: json(CursorEventPageSchema),
        BillingQuote: json(BillingQuoteSchema),
        CreateBillingCheckoutRequest: json(CreateBillingCheckoutRequestSchema),
        BillingCheckoutResponse: json(BillingCheckoutResponseSchema),
        UpdateAutoTopupRequest: json(UpdateAutoTopupRequestSchema),
        OrganizationBilling: json(OrganizationBillingSchema),
        BillingSetupResponse: json(BillingSetupResponseSchema),
        ProjectId: json(ProjectIdSchema),
        SandboxId: {
          type: "string",
          pattern: "^sbx_[A-Za-z0-9]+$",
        },
        OperationId: {
          type: "string",
          pattern: "^op_[A-Za-z0-9]+$",
        },
        Cursor: { type: "string", minLength: 1, maxLength: 512 },
      },
      parameters: {
        OrganizationIdPath: {
          name: "organization_id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        InvitationIdPath: {
          name: "invitation_id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        MemberUserIdPath: {
          name: "user_id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        ProviderPath: {
          name: "provider",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: [
              "blaxel",
              "cloudflare",
              "codesandbox",
              "daytona",
              "e2b",
              "modal",
              "northflank",
              "runloop",
              "vercel",
            ],
          },
        },
        ProjectIdPath: {
          name: "project_id",
          in: "path",
          required: true,
          schema: ref("ProjectId"),
        },
        ApiKeyIdPath: {
          name: "api_key_id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        SandboxIdPath: {
          name: "sandbox_id",
          in: "path",
          required: true,
          schema: ref("SandboxId"),
        },
        OperationIdPath: {
          name: "operation_id",
          in: "path",
          required: true,
          schema: ref("OperationId"),
        },
        ProjectScopeHeader: {
          name: "X-Metal-Project-ID",
          in: "header",
          required: true,
          description: "Public project ID used to scope sandbox access.",
          schema: ref("ProjectId"),
        },
        IdempotencyKeyHeader: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 512 },
        },
        OptionalIdempotencyKeyHeader: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 512 },
        },
        LastEventIdHeader: {
          name: "Last-Event-ID",
          in: "header",
          required: false,
          description: "Resume after the last received operation event sequence.",
          schema: { type: "integer", minimum: 0 },
        },
        CursorQuery: {
          name: "cursor",
          in: "query",
          required: false,
          schema: ref("Cursor"),
        },
        LimitQuery: {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          tags: ["ops"],
          responses: {
            "200": response("Process is alive", "HealthResponse"),
          },
        },
      },
      "/ready": {
        get: {
          operationId: "getReady",
          tags: ["ops"],
          responses: {
            "200": response("Dependencies are ready", "ReadinessResponse"),
            "503": response("Dependencies are not ready", "ReadinessResponse"),
          },
        },
      },
      "/v1/meta": {
        get: {
          operationId: "getMeta",
          tags: ["ops"],
          responses: {
            "200": response("API metadata", "ApiMetadataResponse"),
          },
        },
      },
      "/v1/organizations": {
        get: {
          operationId: "listOrganizations",
          tags: ["organizations"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response(
              "Organizations for the authenticated principal",
              "OrganizationListResponse",
            ),
            "401": errorResponse("Authentication required"),
          },
        },
        post: {
          operationId: "createOrganization",
          tags: ["organizations"],
          security: [{ bearerAuth: [] }],
          parameters: [parameterRef("OptionalIdempotencyKeyHeader")],
          requestBody: {
            required: true,
            content: jsonContent("CreateOrganizationRequest"),
          },
          responses: {
            "201": response("Organization created", "Organization"),
            "401": errorResponse("Authentication required"),
            "409": errorResponse("Organization conflict"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/organizations/{organization_id}": {
        parameters: [parameterRef("OrganizationIdPath")],
        get: {
          operationId: "getOrganization",
          tags: ["organizations"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Organization", "Organization"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Organization not found"),
          },
        },
      },
      "/v1/organizations/{organization_id}/members": {
        parameters: [parameterRef("OrganizationIdPath")],
        get: {
          operationId: "listOrganizationMembers",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response(
              "Members and pending invitations for the organization",
              "OrganizationMembersResponse",
            ),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
          },
        },
      },
      "/v1/organizations/{organization_id}/members/{user_id}": {
        parameters: [parameterRef("OrganizationIdPath"), parameterRef("MemberUserIdPath")],
        patch: {
          operationId: "updateOrganizationMember",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("UpdateOrganizationRoleRequest"),
          },
          responses: {
            "200": response("Member role updated", "OrganizationMember"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Member not found"),
            "422": errorResponse("Invalid request"),
          },
        },
        delete: {
          operationId: "removeOrganizationMember",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Member removed", "OrganizationMemberDeleteResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Member not found"),
            "409": errorResponse("Cannot remove the last owner"),
          },
        },
      },
      "/v1/organizations/{organization_id}/invitations": {
        parameters: [parameterRef("OrganizationIdPath")],
        post: {
          operationId: "createOrganizationInvitation",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("CreateOrganizationInvitationRequest"),
          },
          responses: {
            "200": response("Existing pending invitation", "OrganizationInvitation"),
            "201": response("Invitation created", "OrganizationInvitation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "409": errorResponse("Invitee is already a member"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/organizations/{organization_id}/invitations/{invitation_id}": {
        parameters: [parameterRef("OrganizationIdPath"), parameterRef("InvitationIdPath")],
        patch: {
          operationId: "updateOrganizationInvitation",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("UpdateOrganizationRoleRequest"),
          },
          responses: {
            "200": response("Invitation role updated", "OrganizationInvitation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Invitation not found"),
            "422": errorResponse("Invalid request"),
          },
        },
        delete: {
          operationId: "revokeOrganizationInvitation",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Invitation revoked", "OrganizationInvitationRevokeResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Invitation not found"),
          },
        },
      },
      "/v1/organizations/{organization_id}/invitations/{invitation_id}/resend": {
        parameters: [parameterRef("OrganizationIdPath"), parameterRef("InvitationIdPath")],
        post: {
          operationId: "resendOrganizationInvitation",
          tags: ["members"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Invitation resent", "OrganizationInvitation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Invitation not found"),
          },
        },
      },
      "/v1/organizations/{organization_id}/billing": {
        parameters: [parameterRef("OrganizationIdPath")],
        get: {
          operationId: "getOrganizationBilling",
          tags: ["billing"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Organization billing summary", "OrganizationBilling"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
          },
        },
      },
      "/v1/organizations/{organization_id}/billing/quote": {
        parameters: [parameterRef("OrganizationIdPath")],
        get: {
          operationId: "quoteCreditPurchase",
          tags: ["billing"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "amount_usd",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": response("Credit purchase quote", "BillingQuote"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/organizations/{organization_id}/billing/checkout": {
        parameters: [parameterRef("OrganizationIdPath")],
        post: {
          operationId: "createBillingCheckout",
          tags: ["billing"],
          security: [{ bearerAuth: [] }],
          parameters: [parameterRef("OptionalIdempotencyKeyHeader")],
          requestBody: {
            required: true,
            content: jsonContent("CreateBillingCheckoutRequest"),
          },
          responses: {
            "200": response("Checkout session created", "BillingCheckoutResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "422": errorResponse("Invalid request"),
            "503": errorResponse("Billing is not configured"),
          },
        },
      },
      "/v1/organizations/{organization_id}/billing/auto-topup": {
        parameters: [parameterRef("OrganizationIdPath")],
        put: {
          operationId: "updateAutoTopup",
          tags: ["billing"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("UpdateAutoTopupRequest"),
          },
          responses: {
            "200": response("Automatic top up policy updated", "OrganizationBilling"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "409": errorResponse("Payment method required"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/organizations/{organization_id}/billing/payment-method": {
        parameters: [parameterRef("OrganizationIdPath")],
        post: {
          operationId: "createBillingPaymentMethodSetup",
          tags: ["billing"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Payment method setup session", "BillingSetupResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "503": errorResponse("Billing is not configured"),
          },
        },
      },
      "/v1/webhooks/stripe": {
        post: {
          operationId: "stripeWebhook",
          tags: ["billing"],
          security: [],
          responses: {
            "200": {
              description: "Webhook accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { received: { type: "boolean" } },
                    required: ["received"],
                  },
                },
              },
            },
            "400": errorResponse("Invalid webhook"),
          },
        },
      },
      "/v1/organizations/{organization_id}/projects": {
        parameters: [parameterRef("OrganizationIdPath")],
        get: {
          operationId: "listProjects",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Projects in the organization", "ProjectListResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Organization not found"),
          },
        },
        post: {
          operationId: "createProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          parameters: [parameterRef("OptionalIdempotencyKeyHeader")],
          requestBody: {
            required: true,
            content: jsonContent("CreateProjectRequest"),
          },
          responses: {
            "201": response("Project created", "Project"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "409": errorResponse("Project conflict"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/organizations/{organization_id}/provider-credentials": {
        parameters: [parameterRef("OrganizationIdPath")],
        get: {
          operationId: "listProviderCredentials",
          tags: ["provider credentials"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response(
              "Configured provider credentials without secret values",
              "ProviderCredentialListResponse",
            ),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
          },
        },
      },
      "/v1/organizations/{organization_id}/provider-credentials/{provider}": {
        parameters: [parameterRef("OrganizationIdPath"), parameterRef("ProviderPath")],
        put: {
          operationId: "configureProviderCredential",
          tags: ["provider credentials"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("ProviderCredentialInput"),
          },
          responses: {
            "200": response("Provider credential replaced", "ConfiguredProviderCredential"),
            "201": response("Provider credential configured", "ConfiguredProviderCredential"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "422": errorResponse("Invalid provider credential"),
          },
        },
        delete: {
          operationId: "removeProviderCredential",
          tags: ["provider credentials"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Provider credential removed", "ProviderCredentialDeleteResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Provider credential not configured"),
          },
        },
      },
      "/v1/projects/{project_id}": {
        parameters: [parameterRef("ProjectIdPath")],
        get: {
          operationId: "getProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Project", "Project"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project not found"),
          },
        },
        patch: {
          operationId: "updateProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("UpdateProjectRequest"),
          },
          responses: {
            "200": response("Project updated", "Project"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project not found"),
            "409": errorResponse("Project conflict"),
            "422": errorResponse("Invalid request"),
          },
        },
        delete: {
          operationId: "deleteProject",
          tags: ["projects"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Project deleted", "ProjectDeleteResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project not found"),
          },
        },
      },
      "/v1/projects/{project_id}/api-keys": {
        parameters: [parameterRef("ProjectIdPath")],
        get: {
          operationId: "listProjectApiKeys",
          tags: ["api keys"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("API keys for the project", "ProjectApiKeyListResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project not found"),
          },
        },
        post: {
          operationId: "createProjectApiKey",
          tags: ["api keys"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent("CreateProjectApiKeyRequest"),
          },
          responses: {
            "201": response("Project API key created", "CreateProjectApiKeyResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project not found"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/projects/{project_id}/api-keys/{api_key_id}": {
        parameters: [parameterRef("ProjectIdPath"), parameterRef("ApiKeyIdPath")],
        delete: {
          operationId: "deleteProjectApiKey",
          tags: ["api keys"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Project API key deleted", "ProjectApiKeyDeleteResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project API key not found"),
          },
        },
      },
      "/v1/projects/{project_id}/api-keys/{api_key_id}/revoke": {
        parameters: [parameterRef("ProjectIdPath"), parameterRef("ApiKeyIdPath")],
        post: {
          operationId: "revokeProjectApiKey",
          tags: ["api keys"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Project API key revoked", "ProjectApiKey"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project API key not found"),
          },
        },
      },
      "/v1/projects/{project_id}/sandboxes": {
        parameters: [parameterRef("ProjectIdPath")],
        get: {
          operationId: "listProjectSandboxes",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Sandboxes in the project", "ProjectSandboxListResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Project not found"),
          },
        },
      },
      "/v1/projects/{project_id}/sandboxes/{sandbox_id}/pause": {
        parameters: [parameterRef("ProjectIdPath"), parameterRef("SandboxIdPath")],
        post: {
          operationId: "pauseProjectSandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Sandbox pause requested", "SandboxMutation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Sandbox not found"),
            "409": errorResponse("Sandbox cannot be paused"),
          },
        },
      },
      "/v1/projects/{project_id}/sandboxes/{sandbox_id}": {
        parameters: [parameterRef("ProjectIdPath"), parameterRef("SandboxIdPath")],
        delete: {
          operationId: "destroyProjectSandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Sandbox destruction requested", "SandboxMutation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Sandbox not found"),
          },
        },
      },
      "/v1/sandboxes": {
        parameters: [parameterRef("ProjectScopeHeader")],
        get: {
          operationId: "listSandboxes",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          parameters: [parameterRef("CursorQuery"), parameterRef("LimitQuery")],
          responses: {
            "200": response("Sandbox page", "SandboxListResponse"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "422": errorResponse("Invalid cursor"),
          },
        },
        post: {
          operationId: "createSandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          parameters: [parameterRef("IdempotencyKeyHeader")],
          requestBody: {
            required: true,
            content: jsonContent("CreateSandboxRequest"),
          },
          responses: {
            "202": response("Sandbox provisioning operation accepted", "SandboxMutation"),
            "401": errorResponse("Authentication required"),
            "402": errorResponse("Insufficient credits"),
            "403": errorResponse("Access denied"),
            "409": errorResponse("Idempotency conflict"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
      "/v1/sandboxes/{sandbox_id}": {
        parameters: [parameterRef("SandboxIdPath"), parameterRef("ProjectScopeHeader")],
        get: {
          operationId: "getSandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Sandbox", "Sandbox"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Sandbox not found"),
          },
        },
        delete: {
          operationId: "destroySandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "202": response("Sandbox destruction accepted", "SandboxMutation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Sandbox not found"),
          },
        },
      },
      "/v1/sandboxes/{sandbox_id}/actions/pause": {
        parameters: [parameterRef("SandboxIdPath"), parameterRef("ProjectScopeHeader")],
        post: {
          operationId: "pauseSandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "202": response("Sandbox pause accepted", "SandboxMutation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Sandbox not found"),
            "409": errorResponse("Sandbox cannot be paused"),
          },
        },
      },
      "/v1/sandboxes/{sandbox_id}/actions/resume": {
        parameters: [parameterRef("SandboxIdPath"), parameterRef("ProjectScopeHeader")],
        post: {
          operationId: "resumeSandbox",
          tags: ["sandboxes"],
          security: [{ bearerAuth: [] }],
          responses: {
            "202": response("Sandbox resume accepted", "SandboxMutation"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "404": errorResponse("Sandbox not found"),
            "409": errorResponse("Sandbox cannot be resumed"),
          },
        },
      },
      "/v1/operations/{operation_id}": {
        parameters: [parameterRef("OperationIdPath")],
        get: {
          operationId: "getOperation",
          tags: ["operations"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response("Operation", "Operation"),
            "401": errorResponse("Authentication required"),
            "404": errorResponse("Operation not found"),
          },
        },
      },
      "/v1/operations/{operation_id}/events": {
        parameters: [parameterRef("OperationIdPath"), parameterRef("LastEventIdHeader")],
        get: {
          operationId: "streamOperationEvents",
          tags: ["operations"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description:
                "Finite SSE batch of operation events ordered by sequence. Each data field is an OperationEvent.",
              content: {
                "text/event-stream": {
                  schema: {
                    type: "string",
                    examples: [
                      'id: 1\nevent: queued\ndata: {"sequence":1,"operation_id":"op_example","type":"queued","occurred_at":"2026-08-20T08:00:00.000Z","data":{}}\n\n',
                    ],
                  },
                },
              },
            },
            "401": errorResponse("Authentication required"),
            "404": errorResponse("Operation not found"),
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
              schema: ref("ProjectId"),
            },
            {
              name: "after",
              in: "query",
              required: false,
              schema: ref("Cursor"),
            },
            parameterRef("LimitQuery"),
          ],
          responses: {
            "200": response("Durable event page", "CursorEventPage"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Access denied"),
            "422": errorResponse("Invalid request"),
          },
        },
      },
    },
  };
}

export const OpenApiQueryReference = ListEventsQuerySchema;
