import { z } from "zod";
import type {
  ProviderCreateSandboxInput,
  ProviderDestroyResult,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

const ACTIVE_CPU_USD_PER_HOUR = 0.128;
const MEMORY_GIB_USD_PER_HOUR = 0.0212;
const CREATION_USD = 0.0000006;
const EGRESS_USD_PER_GB = 0.15;

const SessionSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    vcpus: z.number().positive(),
    memory: z.number().positive(),
    duration: z.number().nonnegative().optional(),
    startedAt: z.number().optional(),
    stoppedAt: z.number().optional(),
    activeCpuDurationMs: z.number().nonnegative().optional(),
    networkTransfer: z
      .object({
        ingress: z.number().nonnegative(),
        egress: z.number().nonnegative(),
      })
      .optional(),
  })
  .passthrough();

const NamedSandboxSchema = z
  .object({
    name: z.string().min(1),
    currentSessionId: z.string().min(1).optional(),
    status: z.enum(["running", "stopped", "stopping"]),
    persistent: z.boolean(),
    vcpus: z.number().positive().optional(),
    memory: z.number().positive().optional(),
    totalActiveCpuDurationMs: z.number().nonnegative().optional(),
    totalDurationMs: z.number().nonnegative().optional(),
    totalEgressBytes: z.number().nonnegative().optional(),
    totalIngressBytes: z.number().nonnegative().optional(),
  })
  .passthrough();

const SandboxResponseSchema = z
  .object({
    sandbox: NamedSandboxSchema,
    session: SessionSchema.optional(),
  })
  .passthrough();

const StopResponseSchema = z
  .object({
    sandbox: NamedSandboxSchema.optional(),
    session: SessionSchema,
  })
  .passthrough();

export type VercelSandboxProviderOptions = {
  token: string;
  projectId: string;
  teamId?: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class VercelRequestError extends Error {
  constructor(readonly status: number) {
    super(`Vercel request failed (${status})`);
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel" as const;
  readonly capabilities = { pause: false, cost: true } as const;
  private readonly token: string;
  private readonly projectId: string;
  private readonly teamId?: string;
  private readonly apiUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VercelSandboxProviderOptions) {
    this.token = options.token;
    this.projectId = options.projectId;
    this.teamId = options.teamId;
    this.apiUrl = (options.apiUrl ?? "https://api.vercel.com").replace(/\/$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const name = `metal-${input.metalSandboxId}`;
    const existing = await this.getNamedSandbox(name, input.signal);
    const response =
      existing ??
      SandboxResponseSchema.parse(
        await this.request(`/v4/sandboxes${this.query()}`, {
          method: "POST",
          body: JSON.stringify({
            name,
            projectId: this.projectId,
            persistent: false,
            timeout: input.ttlMinutes * 60_000,
            ...(input.image ? { image: input.image } : {}),
            tags: {
              "metal.sandbox_id": input.metalSandboxId,
              "metal.organization_id": input.organizationId,
              "metal.project_id": input.projectId,
            },
          }),
          signal: input.signal,
        }),
      );
    const session = response.session;
    return {
      providerResourceId: response.sandbox.name,
      providerOrganizationId: this.teamId ?? this.projectId,
      providerMetadata: {
        vercel: {
          sandbox: response.sandbox,
          ...(session ? { session } : {}),
        },
      },
    };
  }

  async pause(): Promise<void> {
    throw new Error("Vercel sandboxes do not support pause");
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<ProviderDestroyResult> {
    const existing = await this.getNamedSandbox(providerResourceId, signal);
    if (!existing) {
      return {};
    }
    let stopped = existing;
    if (existing.sandbox.currentSessionId && existing.sandbox.status !== "stopped") {
      const stopResponse = StopResponseSchema.parse(
        await this.request(
          `/v2/sandboxes/sessions/${encodeURIComponent(
            existing.sandbox.currentSessionId,
          )}/stop${this.query()}`,
          { method: "POST", body: JSON.stringify({}), signal },
        ),
      );
      stopped = {
        sandbox: stopResponse.sandbox ?? existing.sandbox,
        session: stopResponse.session,
      };
    }
    await this.request(
      `/v2/sandboxes/${encodeURIComponent(providerResourceId)}${this.query({
        projectId: this.projectId,
      })}`,
      { method: "DELETE", signal, allowNotFound: true },
    );
    return {
      providerMetadata: {
        vercel: {
          sandbox: stopped.sandbox,
          ...(stopped.session ? { session: stopped.session } : {}),
        },
      },
    };
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const evidence = z
      .object({
        vercel: z.object({
          sandbox: NamedSandboxSchema,
          session: SessionSchema.optional(),
        }),
      })
      .safeParse(input.providerMetadata);
    const session = evidence.success ? evidence.data.vercel.session : undefined;
    const sandbox = evidence.success ? evidence.data.vercel.sandbox : undefined;
    if (session?.activeCpuDurationMs === undefined || session.duration === undefined) {
      return null;
    }
    const activeCpuCost = (session.activeCpuDurationMs / 3_600_000) * ACTIVE_CPU_USD_PER_HOUR;
    const memoryDurationMs = Math.max(session.duration, 60_000);
    const memoryCost =
      (memoryDurationMs / 3_600_000) * (session.memory / 1_024) * MEMORY_GIB_USD_PER_HOUR;
    const egressBytes = session.networkTransfer?.egress ?? sandbox?.totalEgressBytes ?? 0;
    const egressCost = (egressBytes / 1_000_000_000) * EGRESS_USD_PER_GB;
    const amountMicrousd = BigInt(
      Math.round((activeCpuCost + memoryCost + CREATION_USD + egressCost) * 1_000_000),
    );
    return {
      amountMicrousd,
      providerOrganizationId: this.teamId ?? this.projectId,
      measuredThrough: session.stoppedAt ? new Date(session.stoppedAt) : input.to,
      raw: {
        source: "vercel-session-usage",
        rateCardVersion: "2026-08-04",
        activeCpuUsdPerHour: ACTIVE_CPU_USD_PER_HOUR,
        memoryGibUsdPerHour: MEMORY_GIB_USD_PER_HOUR,
        creationUsd: CREATION_USD,
        egressUsdPerGb: EGRESS_USD_PER_GB,
        session,
      },
    };
  }

  private async getNamedSandbox(
    name: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxResponseSchema> | undefined> {
    try {
      return SandboxResponseSchema.parse(
        await this.request(
          `/v2/sandboxes/${encodeURIComponent(name)}${this.query({
            projectId: this.projectId,
            resume: "false",
          })}`,
          { method: "GET", signal },
        ),
      );
    } catch (error) {
      if (error instanceof VercelRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private query(extra: Record<string, string> = {}): string {
    const query = new URLSearchParams(extra);
    if (this.teamId) {
      query.set("teamId", this.teamId);
    }
    const value = query.toString();
    return value ? `?${value}` : "";
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
    },
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return {};
    }
    if (!response.ok) {
      throw new VercelRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
