import { z } from "zod";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

export type DaytonaProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  analyticsApiUrl?: string;
  organizationId?: string;
  target?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class DaytonaRequestError extends Error {
  constructor(readonly status: number) {
    super(`Daytona request failed (${status})`);
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly analyticsApiUrl: string;
  private readonly target?: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private organizationId?: string;

  constructor(options: DaytonaProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://app.daytona.io/api").replace(/\/$/, "");
    this.analyticsApiUrl = (options.analyticsApiUrl ?? "https://analytics.app.daytona.io").replace(
      /\/$/,
      "",
    );
    this.target = options.target;
    this.organizationId = options.organizationId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const name = `metal-${input.metalSandboxId}`;
    let response: unknown;
    try {
      response = await this.request("/sandbox", {
        method: "POST",
        body: JSON.stringify({
          name,
          ephemeral: true,
          autoDeleteInterval: 0,
          ...(input.image ? { image: input.image } : {}),
          ...(this.target ? { target: this.target } : {}),
          labels: {
            "metal.sandbox_id": input.metalSandboxId,
            "metal.organization_id": input.organizationId,
            "metal.project_id": input.projectId,
          },
        }),
        signal: input.signal,
        idempotencyKey: `metal-sandbox-${input.metalSandboxId}`,
      });
    } catch (error) {
      if (!(error instanceof DaytonaRequestError) || error.status !== 409) {
        throw error;
      }
      response = await this.request(`/sandbox/${encodeURIComponent(name)}`, {
        method: "GET",
        signal: input.signal,
      });
    }
    const parsed = z
      .object({
        id: z.string().min(1),
        organizationId: z.string().min(1),
      })
      .passthrough()
      .parse(response);
    this.organizationId = parsed.organizationId;
    return {
      providerResourceId: parsed.id,
      providerOrganizationId: parsed.organizationId,
    };
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const organizationId =
      input.providerOrganizationId ?? this.organizationId ?? (await this.discoverOrganizationId());
    const query = new URLSearchParams({
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    });
    const response = await this.analyticsRequest(
      `/organization/${encodeURIComponent(organizationId)}/usage/sandbox?${query}`,
      input.signal,
    );
    const rows = z
      .array(
        z
          .object({
            sandboxId: z.string(),
            totalPrice: z.number().nonnegative(),
            lastEnd: z.string().optional().nullable(),
          })
          .passthrough(),
      )
      .parse(response);
    const row = rows.find((candidate) => candidate.sandboxId === input.providerResourceId);
    if (!row) {
      return null;
    }
    return {
      amountMicrousd: BigInt(Math.round(row.totalPrice * 1_000_000)),
      providerOrganizationId: organizationId,
      measuredThrough: row.lastEnd ? new Date(row.lastEnd) : input.to,
      raw: row,
    };
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandbox/${encodeURIComponent(providerResourceId)}/pause`, {
      method: "POST",
      signal,
    });
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return {};
    }
    if (!response.ok) {
      throw new DaytonaRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async analyticsRequest(path: string, callerSignal?: AbortSignal): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.analyticsApiUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) {
      throw new DaytonaRequestError(response.status);
    }
    return response.json();
  }

  private async discoverOrganizationId(): Promise<string> {
    const response = await this.request("/sandbox", { method: "GET" });
    const rows = z
      .union([
        z.array(z.object({ organizationId: z.string().min(1) }).passthrough()),
        z.object({
          items: z.array(z.object({ organizationId: z.string().min(1) }).passthrough()),
        }),
      ])
      .parse(response);
    const organizationId = Array.isArray(rows)
      ? rows[0]?.organizationId
      : rows.items[0]?.organizationId;
    if (!organizationId) {
      throw new Error("Daytona organization could not be discovered");
    }
    this.organizationId = organizationId;
    return organizationId;
  }
}
