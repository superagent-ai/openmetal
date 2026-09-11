import { z } from "zod";
import {
  BillingCheckoutResponseSchema,
  BillingQuoteSchema,
  BillingSetupResponseSchema,
  CreateProcessRequestSchema,
  CreateSandboxEndpointRequestSchema,
  CreateSandboxRequestSchema,
  ConfiguredProviderCredentialSchema,
  DeleteFileRequestSchema,
  ListFilesRequestSchema,
  OrganizationBillingSchema,
  OrganizationDeleteResponseSchema,
  OrganizationSchema,
  OrganizationUsageSchema,
  OrganizationInvitationRevokeResponseSchema,
  OrganizationInvitationSchema,
  OrganizationMemberDeleteResponseSchema,
  OrganizationMemberSchema,
  OrganizationMembersResponseSchema,
  OperationEventSchema,
  OperationSchema,
  ProjectApiKeySchema,
  ProcessEventSchema,
  ProcessSchema,
  ProviderCredentialDeleteResponseSchema,
  ProviderCredentialInputSchema,
  ProviderCredentialListResponseSchema,
  ReadFileRequestSchema,
  RuntimeOperationSchema,
  SandboxEndpointListResponseSchema,
  SandboxEndpointSchema,
  SandboxMutationSchema,
  SandboxListResponseSchema,
  SandboxSchema,
  WriteFileRequestSchema,
  CreateWebhookEndpointRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookDeliveryListResponseSchema,
  WebhookDeliverySchema,
  WebhookEndpointDeleteResponseSchema,
  WebhookEndpointListResponseSchema,
  WebhookEndpointSchema,
  WebhookEndpointWithSecretSchema,
  type CreateSandboxRequest,
  type CreateWebhookEndpointRequest,
  type InvitationRole,
  type UpdateWebhookEndpointRequest,
  type OrganizationUsageQuery,
  type Operation,
  type Process,
  type ProcessEvent,
  type ProviderCredentialInput,
  type RuntimeOperation,
  type SandboxEndpoint,
  type SandboxMutation,
} from "@openmetal/contracts";
import { MetalError, RuntimeOperationWaitError } from "./error.js";

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

export type BinaryData = ArrayBuffer | ArrayBufferView | Blob;

export type BinaryWriteFileInput = {
  path: string;
  data: BinaryData;
  mode?: "create" | "overwrite" | "append";
  create_parents?: boolean;
};

export type ProcessEventStreamOptions = {
  lastEventId?: number;
  projectId?: string;
  reconnectDelayMs?: number;
  signal?: AbortSignal;
};

export type RuntimeWaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  projectId?: string;
  signal?: AbortSignal;
};

const TERMINAL_PROCESS_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

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
  signal?: AbortSignal;
  timeoutMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("operation aborted"));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("operation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseEventBatch<T extends { sequence: number; type: string }>(
  raw: string,
  schema: z.ZodType<T>,
  label: string,
): T[] {
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const events: T[] = [];
  let id: string | undefined;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let hasEventFields = false;

  const flush = () => {
    if (!hasEventFields) return;
    if (id === undefined || eventName === undefined || dataLines.length === 0) {
      throw new Error(`${label} event is missing id, event, or data`);
    }

    const event = schema.parse(JSON.parse(dataLines.join("\n")) as unknown);
    if (String(event.sequence) !== id) {
      throw new Error(`${label} event id does not match its sequence`);
    }
    if (event.type !== eventName) {
      throw new Error(`${label} event name does not match its type`);
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
    return parseEventBatch(raw, OperationEventSchema, "operation");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid operation event batch",
    });
    return z.NEVER;
  }
});

const ProcessEventBatchSseSchema = z.string().transform((raw, context) => {
  try {
    return parseEventBatch(raw, ProcessEventSchema, "process");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid process event batch",
    });
    return z.NEVER;
  }
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function binaryDataToBytes(data: BinaryData): Promise<Uint8Array> {
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

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
        schema: OrganizationSchema,
      }),
    update: (organizationId: string, input: { name: string; slug: string }) =>
      this.request({
        method: "PATCH",
        path: `/v1/organizations/${organizationId}`,
        body: input,
        schema: OrganizationSchema,
      }),
    delete: (
      organizationId: string,
      input: { confirm_name: string; confirm_forfeit_balance?: boolean },
    ) =>
      this.request({
        method: "DELETE",
        path: `/v1/organizations/${organizationId}`,
        body: input,
        schema: OrganizationDeleteResponseSchema,
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

  readonly usage = {
    get: (organizationId: string, query: OrganizationUsageQuery = {}) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/usage`,
        query: {
          from: query.from,
          through: query.through,
          project_id: query.project_id,
          provider: query.provider,
          billing_mode: query.billing_mode,
          status: query.status,
          cost_provenance: query.cost_provenance,
          sandbox_id: query.sandbox_id,
          limit: typeof query.limit === "number" ? query.limit : undefined,
        },
        schema: OrganizationUsageSchema,
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

  readonly webhooks = {
    list: (organizationId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/webhooks`,
        schema: WebhookEndpointListResponseSchema,
      }),
    create: (
      organizationId: string,
      input: CreateWebhookEndpointRequest,
      options?: { idempotencyKey?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/webhooks`,
        body: CreateWebhookEndpointRequestSchema.parse(input),
        idempotencyKey: options?.idempotencyKey,
        schema: WebhookEndpointWithSecretSchema,
      }),
    get: (organizationId: string, webhookId: string) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}`,
        schema: WebhookEndpointSchema,
      }),
    update: (organizationId: string, webhookId: string, input: UpdateWebhookEndpointRequest) =>
      this.request({
        method: "PATCH",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}`,
        body: UpdateWebhookEndpointRequestSchema.parse(input),
        schema: WebhookEndpointSchema,
      }),
    delete: (organizationId: string, webhookId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}`,
        schema: WebhookEndpointDeleteResponseSchema,
      }),
    rotate: (organizationId: string, webhookId: string) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}/rotate`,
        schema: WebhookEndpointWithSecretSchema,
      }),
    test: (organizationId: string, webhookId: string) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}/test`,
        schema: WebhookDeliverySchema,
      }),
    listDeliveries: (organizationId: string, webhookId: string, options?: { limit?: number }) =>
      this.request({
        method: "GET",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}/deliveries`,
        query: { limit: options?.limit },
        schema: WebhookDeliveryListResponseSchema,
      }),
    redeliver: (organizationId: string, webhookId: string, deliveryId: string) =>
      this.request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/webhooks/${webhookId}/deliveries/${deliveryId}/redeliver`,
        schema: WebhookDeliverySchema,
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

  readonly processes = {
    create: async (
      sandboxId: string,
      input: z.input<typeof CreateProcessRequestSchema>,
      options?: { idempotencyKey?: string; projectId?: string },
    ) => {
      const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();
      return this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/processes`,
        body: CreateProcessRequestSchema.parse(input),
        idempotencyKey,
        projectId: options?.projectId,
        schema: ProcessSchema,
      }) as Promise<Process>;
    },
    get: (sandboxId: string, processId: string, options?: { projectId?: string }) =>
      this.request({
        method: "GET",
        path: `/v1/sandboxes/${sandboxId}/processes/${processId}`,
        projectId: options?.projectId,
        schema: ProcessSchema,
      }) as Promise<Process>,
    events: (
      sandboxId: string,
      processId: string,
      options: ProcessEventStreamOptions = {},
    ): AsyncIterable<ProcessEvent> => this.streamProcessEvents(sandboxId, processId, options),
    cancel: (
      sandboxId: string,
      processId: string,
      options?: { idempotencyKey?: string; projectId?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/processes/${processId}/actions/cancel`,
        idempotencyKey: options?.idempotencyKey,
        projectId: options?.projectId,
        schema: ProcessSchema,
      }) as Promise<Process>,
  };

  readonly runtimeOperations = {
    get: (
      sandboxId: string,
      runtimeOperationId: string,
      options?: { projectId?: string; signal?: AbortSignal },
    ) =>
      this.request({
        method: "GET",
        path: `/v1/sandboxes/${sandboxId}/runtime-operations/${runtimeOperationId}`,
        projectId: options?.projectId,
        schema: RuntimeOperationSchema,
        signal: options?.signal,
      }) as Promise<RuntimeOperation>,
    wait: async (
      operationOrId: RuntimeOperation | string,
      options: RuntimeWaitOptions & { sandboxId?: string } = {},
    ) => {
      const operationId = typeof operationOrId === "string" ? operationOrId : operationOrId.id;
      const sandboxId =
        typeof operationOrId === "string" ? options.sandboxId : operationOrId.sandbox_id;
      if (!sandboxId) {
        throw new Error("sandboxId is required when waiting by runtime operation ID");
      }
      const deadline = Date.now() + (options.timeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new Error("runtime operation wait aborted");
        }
        const operation = await this.runtimeOperations.get(sandboxId, operationId, options);
        if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
          return operation;
        }
        await abortableSleep(options.pollIntervalMs ?? 500, options.signal);
      }
      throw new Error(`runtime operation ${operationId} did not complete before timeout`);
    },
  };

  readonly filesystem = {
    read: (
      sandboxId: string,
      input: z.input<typeof ReadFileRequestSchema>,
      options?: { projectId?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/filesystem/read`,
        body: ReadFileRequestSchema.parse(input),
        projectId: options?.projectId,
        schema: RuntimeOperationSchema,
      }) as Promise<RuntimeOperation>,
    write: async (
      sandboxId: string,
      input: z.input<typeof WriteFileRequestSchema> | BinaryWriteFileInput,
      options?: { idempotencyKey?: string; projectId?: string },
    ) => {
      const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();
      const body =
        "data" in input
          ? {
              path: input.path,
              data_base64: bytesToBase64(await binaryDataToBytes(input.data)),
              mode: input.mode,
              create_parents: input.create_parents,
            }
          : input;
      return this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/filesystem/write`,
        body: WriteFileRequestSchema.parse(body),
        idempotencyKey,
        projectId: options?.projectId,
        schema: RuntimeOperationSchema,
      }) as Promise<RuntimeOperation>;
    },
    list: (
      sandboxId: string,
      input: z.input<typeof ListFilesRequestSchema>,
      options?: { projectId?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/filesystem/list`,
        body: ListFilesRequestSchema.parse(input),
        projectId: options?.projectId,
        schema: RuntimeOperationSchema,
      }) as Promise<RuntimeOperation>,
    delete: (
      sandboxId: string,
      input: z.input<typeof DeleteFileRequestSchema>,
      options?: { idempotencyKey?: string; projectId?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/filesystem/delete`,
        body: DeleteFileRequestSchema.parse(input),
        idempotencyKey: options?.idempotencyKey,
        projectId: options?.projectId,
        schema: RuntimeOperationSchema,
      }) as Promise<RuntimeOperation>,
    upload: async (
      sandboxId: string,
      path: string,
      data: BinaryData,
      options: RuntimeWaitOptions & {
        createParents?: boolean;
        idempotencyKey?: string;
        mode?: "create" | "overwrite" | "append";
      } = {},
    ) => {
      const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
      const operation = await this.filesystem.write(
        sandboxId,
        {
          path,
          data,
          mode: options.mode,
          create_parents: options.createParents,
        },
        { ...options, idempotencyKey },
      );
      try {
        const completed = await this.runtimeOperations.wait(operation, options);
        if (completed.state !== "succeeded") {
          throw new Error(completed.error?.message ?? `filesystem write for ${path} failed`);
        }
        return completed;
      } catch (error) {
        throw new RuntimeOperationWaitError({
          message: error instanceof Error ? error.message : `filesystem write for ${path} failed`,
          operationId: operation.id,
          idempotencyKey,
          cause: error,
        });
      }
    },
    download: async (
      sandboxId: string,
      path: string,
      options: RuntimeWaitOptions & {
        chunkSizeBytes?: number;
        limitBytes?: number;
        offsetBytes?: number;
      } = {},
    ) => {
      let offset = options.offsetBytes ?? 0;
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const operation = await this.filesystem.read(
          sandboxId,
          {
            path,
            offset_bytes: offset,
            limit_bytes: options.chunkSizeBytes ?? options.limitBytes,
          },
          options,
        );
        const completed = await this.runtimeOperations.wait(operation, options);
        if (completed.state !== "succeeded" || completed.result?.kind !== "filesystem_read") {
          throw new Error(completed.error?.message ?? `filesystem read for ${path} failed`);
        }
        const result = completed.result;
        if (result.path !== path) {
          throw new Error(
            `filesystem read for ${path} returned path ${result.path} instead of ${path}`,
          );
        }
        if (result.offset_bytes !== offset) {
          throw new Error(
            `filesystem read for ${path} returned offset ${result.offset_bytes} instead of ${offset}`,
          );
        }
        const chunk = base64ToBytes(result.data_base64);
        if (chunk.byteLength !== result.byte_length) {
          throw new Error(`filesystem read for ${path} returned an invalid byte length`);
        }
        if (!result.eof && chunk.byteLength === 0) {
          throw new Error(`filesystem read for ${path} made no progress`);
        }
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
        if (result.eof) break;
        offset += chunk.byteLength;
      }
      const bytes = new Uint8Array(totalBytes);
      let targetOffset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, targetOffset);
        targetOffset += chunk.byteLength;
      }
      return bytes;
    },
  };

  readonly endpoints = {
    create: (
      sandboxId: string,
      input: z.input<typeof CreateSandboxEndpointRequestSchema>,
      options?: { idempotencyKey?: string; projectId?: string },
    ) =>
      this.request({
        method: "POST",
        path: `/v1/sandboxes/${sandboxId}/endpoints`,
        body: CreateSandboxEndpointRequestSchema.parse(input),
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        projectId: options?.projectId,
        schema: SandboxEndpointSchema,
      }) as Promise<SandboxEndpoint>,
    list: (sandboxId: string, options?: { cursor?: string; limit?: number; projectId?: string }) =>
      this.request({
        method: "GET",
        path: `/v1/sandboxes/${sandboxId}/endpoints`,
        query: { cursor: options?.cursor, limit: options?.limit },
        projectId: options?.projectId,
        schema: SandboxEndpointListResponseSchema,
      }),
    revoke: (sandboxId: string, endpointId: string, options?: { projectId?: string }) =>
      this.request({
        method: "DELETE",
        path: `/v1/sandboxes/${sandboxId}/endpoints/${endpointId}`,
        projectId: options?.projectId,
        schema: SandboxEndpointSchema,
      }) as Promise<SandboxEndpoint>,
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

  private async *streamProcessEvents(
    sandboxId: string,
    processId: string,
    options: ProcessEventStreamOptions,
  ): AsyncGenerator<ProcessEvent> {
    let lastEventId =
      options.lastEventId === undefined
        ? 0
        : z.number().int().nonnegative().parse(options.lastEventId);
    const reconnectDelayMs = z
      .number()
      .nonnegative()
      .parse(options.reconnectDelayMs ?? 250);
    let firstRequest = true;

    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("process event stream aborted");
      }
      const events = await this.request({
        method: "GET",
        path: `/v1/sandboxes/${sandboxId}/processes/${processId}/events`,
        lastEventId: firstRequest && options.lastEventId === undefined ? undefined : lastEventId,
        projectId: options.projectId,
        responseFormat: "text",
        schema: ProcessEventBatchSseSchema,
        signal: options.signal,
      });
      firstRequest = false;

      for (const event of events) {
        if (event.sequence !== lastEventId + 1) {
          throw new MetalError({
            status: 200,
            code: "internal_error",
            message: `process event sequence ${event.sequence} followed ${lastEventId}`,
            requestId: crypto.randomUUID(),
          });
        }
        lastEventId = event.sequence;
        yield event;
        if (["exited", "cancelled", "timed_out", "failed"].includes(event.type)) {
          return;
        }
      }

      if (events.length === 0) {
        const process = await this.processes.get(sandboxId, processId, {
          projectId: options.projectId,
        });
        if (TERMINAL_PROCESS_STATES.has(process.state)) {
          return;
        }
      }
      await abortableSleep(reconnectDelayMs, options.signal);
    }
  }

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
    const abortFromSignal = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromSignal();
    } else {
      options.signal?.addEventListener("abort", abortFromSignal, { once: true });
    }
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
            idempotencyKey: options.idempotencyKey,
          });
        }
      }
      if (!response.ok) {
        throw MetalError.fromUnknown(response.status, parsed, requestId, options.idempotencyKey);
      }
      const validated = options.schema.safeParse(parsed);
      if (!validated.success) {
        throw new MetalError({
          status: response.status,
          code: "internal_error",
          message: "malformed metal api response",
          requestId,
          details: { issues: validated.error.issues },
          idempotencyKey: options.idempotencyKey,
        });
      }
      return validated.data;
    } catch (error) {
      if (error instanceof MetalError) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("request aborted");
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new MetalError({
          status: 0,
          code: "timeout",
          message: "request timed out",
          requestId,
          retryable: true,
          idempotencyKey: options.idempotencyKey,
        });
      }
      throw new MetalError({
        status: 0,
        code: "internal_error",
        message: error instanceof Error ? error.message : "network error",
        requestId,
        retryable: true,
        idempotencyKey: options.idempotencyKey,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromSignal);
    }
  }
}
