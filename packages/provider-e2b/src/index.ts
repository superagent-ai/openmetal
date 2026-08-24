import { z } from "zod";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

const VCPU_MICROUSD_PER_SECOND = 14;
const RAM_GIB_MICROUSD_PER_SECOND = 4.5;

const SandboxSchema = z
  .object({
    sandboxID: z.string().min(1),
    clientID: z.string().min(1),
    templateID: z.string().min(1),
    startedAt: z.string().datetime().optional(),
    cpuCount: z.number().int().positive().optional(),
    memoryMB: z.number().int().positive().optional(),
    state: z.enum(["running", "paused"]).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const LifecycleEventArraySchema = z.array(
  z
    .object({
      id: z.string().min(1),
      type: z.string(),
      timestamp: z.string().datetime(),
      sandboxExecutionId: z.string().min(1).optional(),
      eventData: z
        .object({
          execution: z
            .object({
              execution_time: z.number().nonnegative(),
              memory_mb: z.number().int().positive(),
              started_at: z.string().datetime(),
              vcpu_count: z.number().int().positive(),
            })
            .optional(),
        })
        .passthrough()
        .optional()
        .nullable(),
    })
    .passthrough(),
);
const LifecycleEventsSchema = z
  .union([LifecycleEventArraySchema, z.object({ events: LifecycleEventArraySchema })])
  .transform((value) => (Array.isArray(value) ? value : value.events));

export type E2BSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  templateId?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class E2BRequestError extends Error {
  constructor(readonly status: number) {
    super(`E2B request failed (${status})`);
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b" as const;
  readonly capabilities = {
    pause: true,
    resume: true,
    cost: true,
    sizing: "template",
    sources: ["environment", "provider_template"],
  } as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly templateId: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: E2BSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://api.e2b.app").replace(/\/$/, "");
    this.templateId = options.templateId ?? "base";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const templateId =
      typeof input.providerOptions?.template_id === "string"
        ? input.providerOptions.template_id
        : input.source.kind === "provider_template"
          ? input.source.template
          : (input.image ?? this.templateId);
    const existing = await this.findByMetalId(input.metalSandboxId, input.signal);
    const created =
      existing ??
      SandboxSchema.parse(
        await this.request("/sandboxes", {
          method: "POST",
          body: JSON.stringify({
            templateID: templateId,
            timeout: input.ttlMinutes * 60,
            autoPause: false,
            secure: true,
            metadata: {
              "metal.sandbox_id": input.metalSandboxId,
              "metal.organization_id": input.organizationId,
              "metal.project_id": input.projectId,
            },
          }),
          signal: input.signal,
        }),
      );
    const detail = SandboxSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(created.sandboxID)}`, {
        method: "GET",
        signal: input.signal,
      }),
    );
    return {
      providerResourceId: detail.sandboxID,
      providerOrganizationId: detail.clientID,
      providerMetadata: {
        startedAt: detail.startedAt,
        cpuCount: detail.cpuCount,
        memoryMB: detail.memoryMB,
        templateId: detail.templateID,
      },
      resolvedResources: {
        vcpu: detail.cpuCount ?? input.resources.vcpu,
        memoryMb: detail.memoryMB ?? input.resources.memoryMb,
        diskMb: input.resources.diskMb ?? null,
        architecture: input.resources.architecture === "arm64" ? "arm64" : "x86_64",
        providerSize: detail.templateID,
      },
    };
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}/pause`, {
      method: "POST",
      body: JSON.stringify({ memory: true }),
      signal,
    });
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    const existing = await this.findByMetalId(metalSandboxId, signal);
    if (!existing) return null;
    return {
      providerResourceId: existing.sandboxID,
      providerOrganizationId: existing.clientID,
      providerMetadata: {
        startedAt: existing.startedAt,
        cpuCount: existing.cpuCount,
        memoryMB: existing.memoryMB,
        templateId: existing.templateID,
      },
      resolvedResources:
        existing.cpuCount && existing.memoryMB
          ? {
              vcpu: existing.cpuCount,
              memoryMb: existing.memoryMB,
              diskMb: null,
              architecture: "x86_64",
              providerSize: existing.templateID,
            }
          : undefined,
    };
  }

  async resume(providerResourceId: string, signal?: AbortSignal): Promise<ProviderSandbox> {
    const detail = SandboxSchema.parse(
      await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}/resume`, {
        method: "POST",
        body: JSON.stringify({ timeout: 3600 }),
        signal,
      }),
    );
    return {
      providerResourceId: detail.sandboxID,
      providerOrganizationId: detail.clientID,
      providerMetadata: {
        startedAt: detail.startedAt,
        cpuCount: detail.cpuCount,
        memoryMB: detail.memoryMB,
        templateId: detail.templateID,
      },
      resolvedResources:
        detail.cpuCount && detail.memoryMB
          ? {
              vcpu: detail.cpuCount,
              memoryMb: detail.memoryMB,
              diskMb: null,
              architecture: "x86_64",
              providerSize: detail.templateID,
            }
          : undefined,
    };
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const response = await this.request(
      `/events/sandboxes/${encodeURIComponent(input.providerResourceId)}?limit=100&orderAsc=true`,
      { method: "GET", signal: input.signal, allowNotFound: true },
    );
    if (!response) return null;
    const events = LifecycleEventsSchema.parse(response);
    const completedExecutions = new Map<
      string,
      { durationMs: number; memoryMB: number; vcpuCount: number; timestamp: Date }
    >();
    for (const event of events) {
      const execution = event.eventData?.execution;
      if (
        execution &&
        event.sandboxExecutionId &&
        (event.type === "sandbox.lifecycle.paused" || event.type === "sandbox.lifecycle.killed")
      ) {
        const previous = completedExecutions.get(event.sandboxExecutionId);
        if (!previous || execution.execution_time > previous.durationMs) {
          completedExecutions.set(event.sandboxExecutionId, {
            durationMs: execution.execution_time,
            memoryMB: execution.memory_mb,
            vcpuCount: execution.vcpu_count,
            timestamp: new Date(event.timestamp),
          });
        }
      }
    }

    let amount = 0;
    let measuredThrough = input.to;
    for (const execution of completedExecutions.values()) {
      amount += this.executionCostMicrousd(
        execution.durationMs / 1_000,
        execution.vcpuCount,
        execution.memoryMB,
      );
      if (execution.timestamp > measuredThrough) {
        measuredThrough = execution.timestamp;
      }
    }

    let detail: z.infer<typeof SandboxSchema> | undefined;
    try {
      detail = SandboxSchema.parse(
        await this.request(`/sandboxes/${encodeURIComponent(input.providerResourceId)}`, {
          method: "GET",
          signal: input.signal,
        }),
      );
    } catch (error) {
      if (!(error instanceof E2BRequestError) || error.status !== 404) {
        throw error;
      }
    }

    if (detail?.state === "running" && detail.startedAt && detail.cpuCount && detail.memoryMB) {
      const startedAt = new Date(detail.startedAt);
      const seconds = Math.max(0, (input.to.getTime() - startedAt.getTime()) / 1_000);
      amount += this.executionCostMicrousd(seconds, detail.cpuCount, detail.memoryMB);
    }
    if (amount === 0 && !detail) {
      return null;
    }

    return {
      amountMicrousd: BigInt(Math.round(amount)),
      providerOrganizationId: input.providerOrganizationId ?? "e2b",
      measuredThrough,
      raw: {
        source: "e2b-lifecycle-events",
        rateCardVersion: "2026-08-21",
        vcpuMicrousdPerSecond: VCPU_MICROUSD_PER_SECOND,
        ramGibMicrousdPerSecond: RAM_GIB_MICROUSD_PER_SECOND,
        lifecycleEvents: events,
      },
    };
  }

  private executionCostMicrousd(seconds: number, vcpuCount: number, memoryMB: number): number {
    return (
      seconds *
      (vcpuCount * VCPU_MICROUSD_PER_SECOND + (memoryMB / 1_024) * RAM_GIB_MICROUSD_PER_SECOND)
    );
  }

  private async findByMetalId(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxSchema> | undefined> {
    const response = await this.request("/sandboxes", { method: "GET", signal });
    return z
      .array(SandboxSchema)
      .parse(response)
      .find((sandbox) => sandbox.metadata?.["metal.sandbox_id"] === metalSandboxId);
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
        "x-api-key": this.apiKey,
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
      throw new E2BRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
