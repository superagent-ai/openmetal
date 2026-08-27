import { z } from "zod";
import {
  BillingCheckoutResponseSchema,
  BillingQuoteSchema,
  BillingSetupResponseSchema,
  CreateSandboxRequestSchema,
  ConfiguredProviderCredentialSchema,
  OrganizationBillingSchema,
  OrganizationInvitationRevokeResponseSchema,
  OrganizationInvitationSchema,
  OrganizationMemberDeleteResponseSchema,
  OrganizationMemberSchema,
  OrganizationMembersResponseSchema,
  OperationEventSchema,
  OperationSchema,
  ProjectApiKeySchema,
  ProviderCredentialDeleteResponseSchema,
  ProviderCredentialInputSchema,
  ProviderCredentialListResponseSchema,
  SandboxMutationSchema,
  SandboxListResponseSchema,
  SandboxSchema,
  type CreateSandboxRequest,
  type InvitationRole,
  type Operation,
  type OperationEvent,
  type ProviderCredentialInput,
  type SandboxMutation,
} from "@openmetal/contracts";
import { MetalError } from "./error.js";

export type AccessTokenProvider = () =>
  Promise<string | null | undefined> | string | null | undefined;

export type MetalClientOptions = {
  baseUrl: string;
  accessToken: AccessTokenProvider;
  projectId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  retry?: {
    attempts?: number;
    backoffMs?: number;
  };
};

type RequestOptions = {
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  lastEventId?: number;
  projectId?: string;
  responseFormat?: "json" | "text";
  schema: z.ZodType;
  timeoutMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}

function parseOperationEventBatch(raw: string): OperationEvent[] {
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const events: OperationEvent[] = [];
  let id: string | undefined;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let hasEventFields = false;

  const flush = () => {
    if (!hasEventFields) return;
    if (id === undefined || eventName === undefined || dataLines.length === 0) {
      throw new Error("operation event is missing id, event, or data");
    }

    const event = OperationEventSchema.parse(JSON.parse(dataLines.join("\n")) as unknown);
    if (String(event.sequence) !== id) {
      throw new Error("operation event id does not match its sequence");
    }
    if (event.type !== eventName) {
      throw new Error("operation event name does not match its type");
    }
    events.push(event);
    id = undefined;
    eventName = undefined;
    dataLines = [];
    hasEventFields = false;
  };

  for (const line of input.split(/\r\n|\r|\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") {
      id = value;
      hasEventFields = true;
    } else if (field === "event") {
      eventName = value;
      hasEventFields = true;
    } else if (field === "data") {
      dataLines.push(value);
      hasEventFields = true;
    }
  }
  flush();

  return events;
}

const OperationEventBatchSseSchema = z.string().transform((raw, context) => {
  try {
    return parseOperationEventBatch(raw);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid operation event batch",
    });
    return z.NEVER;
  }
});

export class MetalClient {
  private readonly baseUrl: string;
  private readonly accessToken: AccessTokenProvider;
  private readonly projectId?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(options: MetalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken;
    this.projectId = options.projectId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl =
      options.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.retryAttempts = options.retry?.attempts ?? 2;
    this.retryBackoffMs = options.retry?.backoffMs ?? 100;
  }

  health() {
    return this.request({
      method: "GET",
      path: "/health",
      schema: z.object({ status: z.literal("ok") }),
    });
  }

  ready() {
    return this.request({
      method: "GET",
      path: "/ready",
      schema: z.object({
        status: z.enum(["ready", "not_ready"]),
        checks: z.object({ database: z.enum(["ok", "error"]) }),
      }),
    });
  }

  meta() {
    return this.request({
      method: "GET",
      path: "/v1/meta",
      schema: z.object({
        name: z.literal("metal"),
        version: z.string(),
        api_version: z.literal("v1"),
        semver: z.string().optional(),
      }),
    });
  }

  readonly organizations = {
    create: (input: { name: string; slug: string }, options?: { idempotencyKey?: string }) =>
      this.request({
        method: "POST",
        path: "/v1/organizations",
        body: input,
        idempotencyKey: options?.idempotencyKey,
        schema: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
        }),
      }),
    list: () =>
      this.request({
        method: "GET",
        path: "/v1/organizations",
        schema: z.object({
          organizations: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              slug: z.string(),
              created_at: z.string(),
              updated_at: z.string(),
            }),
          ),
        }),
      }),
    get: (organizationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}`,
        schema: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
        }),
      }),
  };

  readonly billing = {
    get: (organizationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/billing`,
        schema: OrganizationBillingSchema,
      }),
    quote: (organizationId: string, amountUsd: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/billing/quote`,
        query: { amount_usd: amountUsd },
        schema: BillingQuoteSchema,
      }),
    checkout: (
      organizationId: string,
      input: { amount_usd: string },
      options?: { idempotencyKey?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/billing/checkout`,
        body: input,
        idempotencyKey: options?.idempotencyKey,
        schema: BillingCheckoutResponseSchema,
      }),
    updateAutoTopup: (
      organizationId: string,
      input: {
        enabled: boolean;
        threshold_usd: string;
        refill_usd: string;
        monthly_cap_usd: string;
      },
    ) =>
      this.request({
        method: "PUT",
        path: `/v1/organizations/${organizationId}/billing/auto-topup`,
        body: input,
        schema: OrganizationBillingSchema,
      }),
    setupPaymentMethod: (organizationId: string) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/billing/payment-method`,
        schema: BillingSetupResponseSchema,
      }),
  };

  readonly members = {
    list: (organizationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/members`,
        schema: OrganizationMembersResponseSchema,
      }),
    update: (organizationId: string, userId: string, input: { role: InvitationRole }) =>
      this.request({
        method: "PATCH",
        path: `/v1/organizations/${organizationId}/members/${userId}`,
        body: input,
        schema: OrganizationMemberSchema,
      }),
    remove: (organizationId: string, userId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/organizations/${organizationId}/members/${userId}`,
        schema: OrganizationMemberDeleteResponseSchema,
      }),
  };

  readonly invitations = {
    create: (organizationId: string, input: { email: string; role?: InvitationRole }) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/invitations`,
        body: input,
        schema: OrganizationInvitationSchema,
      }),
    resend: (organizationId: string, invitationId: string) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/invitations/${invitationId}/resend`,
        schema: OrganizationInvitationSchema,
      }),
    update: (organizationId: string, invitationId: string, input: { role: InvitationRole }) =>
      this.request({
        method: "PATCH",
        path: `/v1/organizations/${organizationId}/invitations/${invitationId}`,
        body: input,
        schema: OrganizationInvitationSchema,
      }),
    revoke: (organizationId: string, invitationId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/organizations/${organizationId}/invitations/${invitationId}`,
        schema: OrganizationInvitationRevokeResponseSchema,
      }),
  };

  readonly providerCredentials = {
    list: (organizationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/provider-credentials`,
        schema: ProviderCredentialListResponseSchema,
      }),
    configure: (organizationId: string, input: ProviderCredentialInput) =>
      this.request({
        method: "PUT",
        path: `/v1/organizations/${organizationId}/provider-credentials/${input.provider}`,
        body: ProviderCredentialInputSchema.parse(input),
        schema: ConfiguredProviderCredentialSchema,
      }),
    remove: (organizationId: string, provider: ProviderCredentialInput["provider"]) =>
      this.request({
        method: "DELETE",
        path: `/v1/organizations/${organizationId}/provider-credentials/${provider}`,
        schema: ProviderCredentialDeleteResponseSchema,
      }),
  };

  readonly projects = {
    create: (
      organizationId: string,
      input: { name: string; slug: string },
      options?: { idempotencyKey?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/projects`,
        body: input,
        idempotencyKey: options?.idempotencyKey,
        schema: z.object({
          id: z.string(),
          organization_id: z.string(),
          name: z.string(),
          slug: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
        }),
      }),
    list: (organizationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/projects`,
        schema: z.object({
          projects: z.array(
            z.object({
              id: z.string(),
              organization_id: z.string(),
              name: z.string(),
              slug: z.string(),
              created_at: z.string(),
              updated_at: z.string(),
            }),
          ),
        }),
      }),
    get: (projectId: string) =>
      this.request({
        method: "GET",
        path: `/v1/projects/${projectId}`,
        schema: z.object({
          id: z.string(),
          organization_id: z.string(),
          name: z.string(),
          slug: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
        }),
      }),
    update: (projectId: string, input: { name: string; slug: string }) =>
      this.request({
        method: "PATCH",
        path: `/v1/projects/${projectId}`,
        body: input,
        schema: z.object({
          id: z.string(),
          organization_id: z.string(),
          name: z.string(),
          slug: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
        }),
      }),
    delete: (projectId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/projects/${projectId}`,
        schema: z.object({
          id: z.string(),
          deleted: z.literal(true),
        }),
      }),
  };

  readonly apiKeys = {
    create: (
      projectId: string,
      input: {
        name: string;
        expires_in?: "1h" | "1d" | "7d" | "30d" | "90d" | "180d" | "1y" | null;
      },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/projects/${projectId}/api-keys`,
        body: input,
        schema: z.object({
          api_key: ProjectApiKeySchema,
          key: z.string().startsWith("metal_sk_"),
        }),
      }),
    list: (projectId: string) =>
      this.request({
        method: "GET",
        path: `/v1/projects/${projectId}/api-keys`,
        schema: z.object({ api_keys: z.array(ProjectApiKeySchema) }),
      }),
    revoke: (projectId: string, apiKeyId: string) =>
      this.request({
        method: "POST",
        path: `/v1/projects/${projectId}/api-keys/${apiKeyId}/revoke`,
        schema: ProjectApiKeySchema,
      }),
    delete: (projectId: string, apiKeyId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/projects/${projectId}/api-keys/${apiKeyId}`,
        schema: z.object({ id: z.string(), deleted: z.literal(true) }),
      }),
  };

  readonly operations = {
    get: (operationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/operations/${operationId}`,
        schema: OperationSchema,
      }) as Promise<Operation>,
    events: (operationId: string, options: { lastEventId?: number } = {}) => {
      const lastEventId =
        options.lastEventId === undefined
          ? undefined
          : z.number().int().nonnegative().parse(options.lastEventId);
      return this.request({
        method: "GET",
        path: `/v1/operations/${operationId}/events`,
        lastEventId,
        responseFormat: "text",
        schema: OperationEventBatchSseSchema,
      });
    },
    wait: async (
      operationOrId: Operation | string,
      options: { timeoutMs?: number; signal?: AbortSignal } = {},
    ) => {
      const operationId = typeof operationOrId === "string" ? operationOrId : operationOrId.id;
      const deadline = Date.now() + (options.timeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new Error("operation wait aborted");
        }
        const operation = await this.operations.get(operationId);
        if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
          return operation;
        }
        await sleep(500);
      }
      throw new Error(`operation ${operationId} did not complete before timeout`);
    },
  };

  readonly sandboxes = {
    list: (projectId: string) =>
      this.request({
        method: "GET",
        path: `/v1/projects/${projectId}/sandboxes`,
        schema: z.object({ sandboxes: z.array(SandboxSchema) }),
      }),
    listScoped: (options?: { projectId?: string; cursor?: string; limit?: number }) =>
      this.request({
        method: "GET",
        path: "/v1/sandboxes",
        projectId: options?.projectId,
        query: { cursor: options?.cursor, limit: options?.limit },
        schema: SandboxListResponseSchema,
      }),
    createAsync: (
      input: CreateSandboxRequest,
      options?: { idempotencyKey?: string; projectId?: string },
    ) =>
      this.request({
        method: "POST",
        path: "/v1/sandboxes",
        body: CreateSandboxRequestSchema.parse(input),
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        projectId: options?.projectId,
        schema: SandboxMutationSchema,
      }) as Promise<SandboxMutation>,
    create: async (
      input: CreateSandboxRequest,
      options?: {
        idempotencyKey?: string;
        projectId?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
      },
    ) => {
      const mutation = await this.sandboxes.createAsync(input, options);
      const operation = await this.operations.wait(mutation.operation, options);
      if (operation.state !== "succeeded") {
        throw new Error(operation.error?.message ?? "sandbox creation failed");
      }
      return this.sandboxes.get(mutation.sandbox.id, options);
    },
    get: (sandboxId: string, options?: { projectId?: string }) =>
      this.request({
        method: "GET",
        path: `/v1/sandboxes/${sandboxId}`,
        projectId: options?.projectId,
        schema: SandboxSchema,
      }),
    pauseAsync: (sandboxId: string, options?: { idempotencyKey?: string; projectId?: string }) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/actions/pause`,
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        projectId: options?.projectId,
        schema: SandboxMutationSchema,
      }) as Promise<SandboxMutation>,
    pause: async (
      projectIdOrSandboxId: string,
      maybeSandboxId?: string,
      options?: { timeoutMs?: number; signal?: AbortSignal; projectId?: string },
    ) => {
      const sandboxId = maybeSandboxId ?? projectIdOrSandboxId;
      const projectId = maybeSandboxId ? projectIdOrSandboxId : options?.projectId;
      const mutation = await this.sandboxes.pauseAsync(sandboxId, { projectId });
      const operation = await this.operations.wait(mutation.operation, options);
      if (operation.state !== "succeeded") {
        throw new Error(operation.error?.message ?? "sandbox pause failed");
      }
      return this.sandboxes.get(sandboxId, { projectId });
    },
    resumeAsync: (sandboxId: string, options?: { idempotencyKey?: string; projectId?: string }) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/actions/resume`,
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        projectId: options?.projectId,
        schema: SandboxMutationSchema,
      }) as Promise<SandboxMutation>,
    resume: async (
      sandboxId: string,
      options?: { timeoutMs?: number; signal?: AbortSignal; projectId?: string },
    ) => {
      const mutation = await this.sandboxes.resumeAsync(sandboxId, options);
      const operation = await this.operations.wait(mutation.operation, options);
      if (operation.state !== "succeeded") {
        throw new Error(operation.error?.message ?? "sandbox resume failed");
      }
      return this.sandboxes.get(sandboxId, options);
    },
    deleteAsync: (sandboxId: string, options?: { idempotencyKey?: string; projectId?: string }) =>
      this.request({
        method: "DELETE",
        path: `/v1/sandboxes/${sandboxId}`,
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        projectId: options?.projectId,
        schema: SandboxMutationSchema,
      }) as Promise<SandboxMutation>,
    delete: async (
      sandboxId: string,
      options?: { timeoutMs?: number; signal?: AbortSignal; projectId?: string },
    ) => {
      const mutation = await this.sandboxes.deleteAsync(sandboxId, options);
      const operation = await this.operations.wait(mutation.operation, options);
      if (operation.state !== "succeeded") {
        throw new Error(operation.error?.message ?? "sandbox destroy failed");
      }
      return this.sandboxes.get(sandboxId, options);
    },
    deleteFromProject: async (
      _projectId: string,
      sandboxId: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) => this.sandboxes.delete(sandboxId, { ...options, projectId: _projectId }),
  };

  readonly events = {
    list: (input: { projectId: string; after?: string; limit?: number }) =>
      this.request({
        method: "GET",
        path: "/v1/events",
        query: {
          project_id: input.projectId,
          after: input.after,
          limit: input.limit,
        },
        schema: z.object({
          events: z.array(
            z.object({
              cursor: z.string(),
              event_id: z.string(),
              type: z.string(),
              organization_id: z.string(),
              project_id: z.string().optional(),
              occurred_at: z.string(),
              data: z.record(z.string(), z.unknown()),
            }),
          ),
          next_cursor: z.string().nullable(),
        }),
      }),
  };

  private async request<T>(options: RequestOptions & { schema: z.ZodType<T> }): Promise<T> {
    const idempotent = options.method === "GET";
    const attempts = idempotent ? this.retryAttempts + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.dispatch(options);
      } catch (error) {
        lastError = error;
        const retryable = idempotent && error instanceof MetalError && error.retryable;
        if (!retryable || attempt === attempts - 1) {
          throw error;
        }
        await sleep(jitter(this.retryBackoffMs * 2 ** attempt));
      }
    }

    throw lastError;
  }

  private async dispatch<T>(options: RequestOptions & { schema: z.ZodType<T> }): Promise<T> {
    const token = await this.accessToken();
    const url = new URL(this.baseUrl + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestId = crypto.randomUUID();
    const headers: Record<string, string> = {
      accept: options.responseFormat === "text" ? "text/event-stream" : "application/json",
      "x-request-id": requestId,
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    if (options.lastEventId !== undefined) {
      headers["last-event-id"] = String(options.lastEventId);
    }
    const projectId = options.projectId ?? this.projectId;
    if (projectId) {
      headers["x-metal-project-id"] = projectId;
    }

    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = options.responseFormat === "text" && response.ok ? raw : {};
      if (raw.length > 0 && (options.responseFormat !== "text" || !response.ok)) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new MetalError({
            status: response.status,
            code: "internal_error",
            message: "malformed json response",
            requestId,
          });
        }
      }
      if (!response.ok) {
        throw MetalError.fromUnknown(response.status, parsed, requestId);
      }
      const validated = options.schema.safeParse(parsed);
      if (!validated.success) {
        throw new MetalError({
          status: response.status,
          code: "internal_error",
          message: "malformed metal api response",
          requestId,
          details: { issues: validated.error.issues },
        });
      }
      return validated.data;
    } catch (error) {
      if (error instanceof MetalError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new MetalError({
          status: 0,
          code: "timeout",
          message: "request timed out",
          requestId,
          retryable: true,
        });
      }
      throw new MetalError({
        status: 0,
        code: "internal_error",
        message: error instanceof Error ? error.message : "network error",
        requestId,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
