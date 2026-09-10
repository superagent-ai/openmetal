import { describe, expect, it } from "vitest";
import {
  CreateOrganizationRequestSchema,
  CreateOrganizationInvitationRequestSchema,
  CreateProjectRequestSchema,
  DurableEventEnvelopeSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ListEventsQuerySchema,
  OpaqueIdSchema,
  OrganizationUsageQuerySchema,
  ProviderCredentialInputSchema,
  ReadinessResponseSchema,
  UpdateAutoTopupRequestSchema,
  UpdateOrganizationRoleRequestSchema,
  UpdateProjectRequestSchema,
  buildOpenApiDocument,
} from "../src/index.js";

describe("contract parsing", () => {
  it("accepts a valid health payload", () => {
    expect(HealthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects an unknown health status", () => {
    expect(() => HealthResponseSchema.parse({ status: "fine" })).toThrow();
  });

  it("accepts a ready payload", () => {
    expect(
      ReadinessResponseSchema.parse({
        status: "ready",
        checks: { database: "ok" },
      }),
    ).toMatchObject({ status: "ready" });
  });

  it("rejects a missing error request_id", () => {
    expect(() =>
      ErrorEnvelopeSchema.parse({
        code: "unauthenticated",
        message: "missing token",
      }),
    ).toThrow();
  });

  it("accepts the stable error envelope", () => {
    expect(
      ErrorEnvelopeSchema.parse({
        code: "forbidden",
        message: "not a member",
        request_id: "req_1",
        retryable: false,
        details: { organization_id: "x" },
      }),
    ).toMatchObject({ code: "forbidden" });
  });

  it("rejects an invalid organization slug", () => {
    expect(() =>
      CreateOrganizationRequestSchema.parse({ name: "Acme", slug: "Not Valid" }),
    ).toThrow();
  });

  it("accepts a valid organization create body", () => {
    expect(CreateOrganizationRequestSchema.parse({ name: "Northwind", slug: "northwind" })).toEqual(
      {
        name: "Northwind",
        slug: "northwind",
      },
    );
  });

  it("rejects a project create body with an empty name", () => {
    expect(() => CreateProjectRequestSchema.parse({ name: "  ", slug: "alpha" })).toThrow();
  });

  it("accepts a valid project update body", () => {
    expect(UpdateProjectRequestSchema.parse({ name: "Renamed", slug: "renamed" })).toEqual({
      name: "Renamed",
      slug: "renamed",
    });
  });

  it("rejects a malformed opaque id", () => {
    expect(() => OpaqueIdSchema.parse("proj_123")).toThrow();
  });

  it("accepts a durable event envelope", () => {
    const parsed = DurableEventEnvelopeSchema.parse({
      cursor: "Y3Vyc29y",
      event_id: "11111111-1111-4111-8111-111111111111",
      type: "project.created",
      organization_id: "22222222-2222-4222-8222-222222222222",
      project_id: "prj_33333333333343338333333333333333",
      occurred_at: "2026-08-20T08:00:00.000Z",
      data: { name: "alpha" },
    });
    expect(parsed.type).toBe("project.created");
  });

  it("rejects an event page query without project_id", () => {
    expect(() => ListEventsQuerySchema.parse({ after: "abc" })).toThrow();
  });

  it("validates provider specific BYOK credentials", () => {
    expect(
      ProviderCredentialInputSchema.parse({
        provider: "modal",
        token_id: "token-id",
        token_secret: "token-secret",
      }),
    ).toEqual({
      provider: "modal",
      token_id: "token-id",
      token_secret: "token-secret",
    });
    expect(() =>
      ProviderCredentialInputSchema.parse({
        provider: "northflank",
        api_token: "token",
      }),
    ).toThrow();
    expect(() =>
      ProviderCredentialInputSchema.parse({
        provider: "cloudflare",
        api_url: "not-a-url",
        api_key: "token",
      }),
    ).toThrow();
    expect(
      ProviderCredentialInputSchema.parse({
        provider: "freestyle",
        api_key: "token",
      }),
    ).toEqual({
      provider: "freestyle",
      api_key: "token",
    });
  });

  it("documents organization and project lifecycle operations", () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(document.paths["/v1/projects/{project_id}"]?.patch?.operationId).toBe("updateProject");
    expect(document.paths["/v1/organizations/{organization_id}"]?.patch?.operationId).toBe(
      "updateOrganization",
    );
    expect(document.paths["/v1/organizations/{organization_id}"]?.delete?.operationId).toBe(
      "deleteOrganization",
    );
    expect(
      document.paths["/v1/organizations/{organization_id}/provider-credentials/{provider}"]?.put
        ?.operationId,
    ).toBe("configureProviderCredential");
    expect(
      document.paths["/v1/organizations/{organization_id}/provider-credentials/{provider}"]?.delete
        ?.operationId,
    ).toBe("removeProviderCredential");
    expect(
      document.paths["/v1/organizations/{organization_id}/members/{user_id}"]?.patch?.operationId,
    ).toBe("updateOrganizationMember");
    expect(
      document.paths["/v1/organizations/{organization_id}/invitations/{invitation_id}"]?.patch
        ?.operationId,
    ).toBe("updateOrganizationInvitation");
  });

  it("documents project API-key and project-path sandbox operations", () => {
    const document = buildOpenApiDocument() as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operations = [
      ["get", "/v1/projects/{project_id}/api-keys", "listProjectApiKeys"],
      ["post", "/v1/projects/{project_id}/api-keys", "createProjectApiKey"],
      ["post", "/v1/projects/{project_id}/api-keys/{api_key_id}/revoke", "revokeProjectApiKey"],
      ["delete", "/v1/projects/{project_id}/api-keys/{api_key_id}", "deleteProjectApiKey"],
      ["get", "/v1/projects/{project_id}/sandboxes", "listProjectSandboxes"],
      ["post", "/v1/projects/{project_id}/sandboxes/{sandbox_id}/pause", "pauseProjectSandbox"],
      ["delete", "/v1/projects/{project_id}/sandboxes/{sandbox_id}", "destroyProjectSandbox"],
    ] as const;

    for (const [method, path, operationId] of operations) {
      expect(document.paths[path]?.[method]?.operationId).toBe(operationId);
    }
    expect(document.components.schemas).toMatchObject({
      ProjectApiKey: expect.any(Object),
      CreateProjectApiKeyRequest: expect.any(Object),
      CreateProjectApiKeyResponse: expect.any(Object),
      ProjectApiKeyListResponse: expect.any(Object),
      ProjectApiKeyDeleteResponse: expect.any(Object),
      ProjectSandboxListResponse: expect.any(Object),
    });
  });

  it("accepts an organization invitation payload", () => {
    expect(
      CreateOrganizationInvitationRequestSchema.parse({
        email: "teammate@example.com",
      }),
    ).toEqual({ email: "teammate@example.com", role: "member" });
    expect(() =>
      CreateOrganizationInvitationRequestSchema.parse({
        email: "not-an-email",
        role: "member",
      }),
    ).toThrow();
    expect(() =>
      CreateOrganizationInvitationRequestSchema.parse({
        email: "teammate@example.com",
        role: "owner",
      }),
    ).toThrow();
  });

  it("accepts an assignable organization role update", () => {
    expect(UpdateOrganizationRoleRequestSchema.parse({ role: "admin" })).toEqual({
      role: "admin",
    });
    expect(() => UpdateOrganizationRoleRequestSchema.parse({ role: "owner" })).toThrow();
  });

  it("documents organization billing routes", () => {
    const document = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };
    expect(document.paths["/v1/organizations/{organization_id}/billing"]?.get?.operationId).toBe(
      "getOrganizationBilling",
    );
    expect(
      document.paths["/v1/organizations/{organization_id}/billing/checkout"]?.post?.operationId,
    ).toBe("createBillingCheckout");
    expect(document.paths["/v1/webhooks/stripe"]?.post?.operationId).toBe("stripeWebhook");
    expect(document.paths["/v1/sandboxes"]?.post?.responses?.["402"]).toBeTruthy();
    expect(document.paths["/v1/organizations/{organization_id}/usage"]?.get?.operationId).toBe(
      "getOrganizationUsage",
    );
  });

  it("validates organization usage filters", () => {
    expect(
      OrganizationUsageQuerySchema.parse({
        from: "2026-08-01T00:00:00.000Z",
        through: "2026-08-27T00:00:00.000Z",
        provider: "e2b",
        billing_mode: "byok",
      }),
    ).toMatchObject({ provider: "e2b", billing_mode: "byok" });
    expect(() =>
      OrganizationUsageQuerySchema.parse({
        from: "2026-08-28T00:00:00.000Z",
        through: "2026-08-27T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts automatic top up settings", () => {
    expect(
      UpdateAutoTopupRequestSchema.parse({
        enabled: true,
        threshold_usd: "10.00",
        refill_usd: "50.00",
        monthly_cap_usd: "500.00",
      }),
    ).toMatchObject({ enabled: true, refill_usd: "50.00" });
  });
});
