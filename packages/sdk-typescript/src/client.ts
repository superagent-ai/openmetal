import { z } from "zod";
import { ProjectApiKeySchema, SandboxSchema } from "@openmetal/contracts";
import { MetalError } from "./error.js";

export type AccessTokenProvider = () =>
  Promise<string | null | undefined> | string | null | undefined;

export type MetalClientOptions = {
  baseUrl: string;
  accessToken: AccessTokenProvider;
  timeoutMs?: number;
  fetch?: typeof fetch;
  retry?: {
    attempts?: number;
    backoffMs?: number;
  };
};

type RequestOptions = {
  method: "DELETE" | "GET" | "PATCH" | "POST";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  schema: z.ZodType;
  timeoutMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}

export class MetalClient {
  private readonly baseUrl: string;
  private readonly accessToken: AccessTokenProvider;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(options: MetalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken;
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

  readonly sandboxes = {
    list: (projectId: string) =>
      this.request({
        method: "GET",
        path: `/v1/projects/${projectId}/sandboxes`,
        schema: z.object({ sandboxes: z.array(SandboxSchema) }),
      }),
    pause: (projectId: string, sandboxId: string) =>
      this.request({
        method: "POST",
        path: `/v1/projects/${projectId}/sandboxes/${sandboxId}/pause`,
        schema: SandboxSchema,
      }),
    deleteFromProject: (projectId: string, sandboxId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/projects/${projectId}/sandboxes/${sandboxId}`,
        schema: SandboxSchema,
      }),
    create: (
      input: {
        project_id?: string;
        provider?: "cloudflare" | "daytona" | "e2b" | "modal" | "vercel";
        image?: string;
        language?: string;
        ttl_minutes?: number;
      } = {},
      options?: { idempotencyKey?: string },
    ) =>
      this.request({
        method: "POST",
        path: "/v1/sandboxes",
        body: input,
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        schema: SandboxSchema,
      }),
    get: (sandboxId: string) =>
      this.request({
        method: "GET",
        path: `/v1/sandboxes/${sandboxId}`,
        schema: SandboxSchema,
      }),
    delete: (sandboxId: string) =>
      this.request({
        method: "DELETE",
        path: `/v1/sandboxes/${sandboxId}`,
        schema: SandboxSchema,
      }),
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
        const retryable =
          idempotent &&
          error instanceof MetalError &&
          (error.status >= 500 || error.code === "timeout");
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
      accept: "application/json",
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

    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = {};
      if (raw.length > 0) {
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
        });
      }
      throw new MetalError({
        status: 0,
        code: "internal_error",
        message: error instanceof Error ? error.message : "network error",
        requestId,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
