import { z } from "zod";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

const SandboxSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.string(),
    updated_at: z.string(),
    title: z.string().nullable().optional(),
    tags: z.array(z.string()),
  })
  .passthrough();

const SandboxListSchema = z
  .object({
    sandboxes: z.array(SandboxSchema),
    pagination: z.object({
      current_page: z.number().int(),
      next_page: z.number().int().nullable(),
      total_records: z.number().int(),
    }),
  })
  .passthrough();

const ForkResponseSchema = z
  .object({
    id: z.string().min(1),
    alias: z.string(),
    title: z.string().nullable(),
  })
  .passthrough();

const StartResponseSchema = z
  .object({
    id: z.string().min(1),
    bootup_type: z.string(),
    cluster: z.string(),
    workspace_path: z.string(),
    user_workspace_path: z.string(),
  })
  .passthrough();

const VmTierSchema = z.enum(["Pico", "Nano", "Micro", "Small", "Medium", "Large", "XLarge"]);
export type CodeSandboxVmTier = z.infer<typeof VmTierSchema>;

const tierCreditsPerHour: Record<CodeSandboxVmTier, bigint> = {
  Pico: 5n,
  Nano: 10n,
  Micro: 20n,
  Small: 40n,
  Medium: 80n,
  Large: 160n,
  XLarge: 320n,
};

export type CodeSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  templateId?: string;
  vmTier?: CodeSandboxVmTier;
  workspaceId?: string;
  creditRateMicrousd?: bigint;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class CodeSandboxRequestError extends Error {
  constructor(readonly status: number) {
    super(`CodeSandbox request failed (${status})`);
  }
}

export class CodeSandboxProvider implements SandboxProvider {
  readonly name = "codesandbox" as const;
  readonly capabilities = {
    pause: true,
    resume: true,
    cost: true,
    sizing: "tier",
    sources: ["environment", "provider_template"],
  } as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly templateId: string;
  private readonly vmTier: CodeSandboxVmTier;
  private readonly workspaceId: string;
  private readonly creditRateMicrousd: bigint;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodeSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://api.codesandbox.io").replace(/\/$/, "");
    this.templateId = options.templateId ?? "pcz35m";
    this.vmTier = VmTierSchema.parse(options.vmTier ?? "Nano");
    this.workspaceId = options.workspaceId ?? "codesandbox-workspace";
    this.creditRateMicrousd = options.creditRateMicrousd ?? 14_860n;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 40_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    await this.request("/vm/running", {
      method: "GET",
      signal: input.signal,
    });
    const tag = `metal-sandbox-${input.metalSandboxId}`;
    const options = input.providerOptions ?? {};
    const resolved = resolveProviderResources("codesandbox", input.resources, options);
    const vmTier = VmTierSchema.parse(resolved.providerSize ?? this.vmTier);
    const templateId =
      typeof options.template_id === "string"
        ? options.template_id
        : input.source.kind === "provider_template"
          ? (input.source.template ?? this.templateId)
          : (input.image ?? this.templateId);
    const existing = await this.findByTag(tag, input.signal);
    const sandbox =
      existing ??
      ForkResponseSchema.parse(
        await this.request(`/sandbox/${encodeURIComponent(templateId)}/fork`, {
          method: "POST",
          body: JSON.stringify({
            title: `metal-${input.metalSandboxId}`,
            description: `Metal sandbox ${input.metalSandboxId}`,
            tags: [
              "metal",
              tag,
              `metal-org-${input.organizationId}`,
              `metal-project-${input.projectId}`,
            ],
            privacy: 2,
            private_preview: true,
            path: "/Metal",
          }),
          signal: input.signal,
        }),
      );
    const startedAt = new Date();
    let started: z.infer<typeof StartResponseSchema>;
    try {
      started = StartResponseSchema.parse(
        await this.request(`/vm/${encodeURIComponent(sandbox.id)}/start`, {
          method: "POST",
          body: JSON.stringify({
            tier: vmTier,
            hibernation_timeout_seconds: Math.max(60, Math.min(86_400, input.ttlMinutes * 60)),
            automatic_wakeup_config: {
              http: false,
              websocket: false,
            },
          }),
          signal: input.signal,
        }),
      );
    } catch (error) {
      await this.destroy(sandbox.id, input.signal).catch(() => undefined);
      throw error;
    }
    const hourlyRateMicrousd = tierCreditsPerHour[vmTier] * this.creditRateMicrousd;
    return {
      providerResourceId: sandbox.id,
      providerOrganizationId: this.workspaceId,
      providerMetadata: {
        codesandbox: {
          sandbox,
          start: started,
        },
        vmTier,
        creditRateMicrousd: this.creditRateMicrousd.toString(),
        hourlyRateMicrousd: hourlyRateMicrousd.toString(),
        startedAt: startedAt.toISOString(),
      },
      resolvedResources: resolved,
    };
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/vm/${encodeURIComponent(providerResourceId)}/hibernate`, {
      method: "POST",
      body: JSON.stringify({}),
      signal,
      allowNotFound: true,
    });
  }

  async reconcileCreate(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<ProviderSandbox | null> {
    const sandbox = await this.findByTag(`metal-sandbox-${metalSandboxId}`, signal);
    if (!sandbox) return null;
    const startedAt = new Date();
    const started = StartResponseSchema.parse(
      await this.request(`/vm/${encodeURIComponent(sandbox.id)}/start`, {
        method: "POST",
        body: JSON.stringify({
          tier: this.vmTier,
          automatic_wakeup_config: { http: false, websocket: false },
        }),
        signal,
      }),
    );
    return {
      providerResourceId: sandbox.id,
      providerOrganizationId: this.workspaceId,
      providerMetadata: {
        codesandbox: { sandbox, start: started },
        vmTier: this.vmTier,
        hourlyRateMicrousd: (tierCreditsPerHour[this.vmTier] * this.creditRateMicrousd).toString(),
        startedAt: startedAt.toISOString(),
      },
    };
  }

  async resume(providerResourceId: string, signal?: AbortSignal): Promise<ProviderSandbox> {
    const started = StartResponseSchema.parse(
      await this.request(`/vm/${encodeURIComponent(providerResourceId)}/start`, {
        method: "POST",
        body: JSON.stringify({
          tier: this.vmTier,
          automatic_wakeup_config: { http: false, websocket: false },
        }),
        signal,
      }),
    );
    return {
      providerResourceId,
      providerOrganizationId: this.workspaceId,
      providerMetadata: {
        vmTier: this.vmTier,
        startedAt: new Date().toISOString(),
        codesandbox: { start: started },
      },
    };
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/vm/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const metadataRate = input.providerMetadata?.hourlyRateMicrousd;
    const hourlyRate =
      typeof metadataRate === "string" && /^\d+$/.test(metadataRate)
        ? BigInt(metadataRate)
        : tierCreditsPerHour[this.vmTier] * this.creditRateMicrousd;
    const metadataStartedAt = input.providerMetadata?.startedAt;
    const startedAt =
      typeof metadataStartedAt === "string" ? new Date(metadataStartedAt) : input.from;
    const elapsedSeconds = Math.max(
      0,
      Math.ceil((input.to.getTime() - startedAt.getTime()) / 1_000),
    );
    const billedMinutes = Math.ceil(elapsedSeconds / 60);
    return {
      amountMicrousd: (BigInt(billedMinutes) * hourlyRate + 30n) / 60n,
      providerOrganizationId: input.providerOrganizationId ?? this.workspaceId,
      measuredThrough: input.to,
      raw: {
        source: "codesandbox-vm-runtime-published-credit-rate",
        vmTier: input.providerMetadata?.vmTier ?? this.vmTier,
        hourlyRateMicrousd: hourlyRate.toString(),
        elapsedSeconds,
        billedMinutes,
        startedAt: startedAt.toISOString(),
        measuredThrough: input.to.toISOString(),
      },
    };
  }

  private async findByTag(
    tag: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxSchema> | undefined> {
    let page = 1;
    while (page > 0) {
      const query = new URLSearchParams({
        tags: tag,
        page: String(page),
        page_size: "50",
        order_by: "inserted_at",
        direction: "desc",
      });
      const result = SandboxListSchema.parse(
        await this.request(`/sandbox?${query}`, {
          method: "GET",
          signal,
        }),
      );
      const existing = result.sandboxes.find((sandbox) => sandbox.tags.includes(tag));
      if (existing) {
        return existing;
      }
      page = result.pagination.next_page ?? 0;
    }
    return undefined;
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
    },
  ): Promise<unknown | null> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new CodeSandboxRequestError(response.status);
    }
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    const envelope = z
      .object({
        success: z.boolean().optional(),
        data: z.unknown().optional(),
        errors: z.array(z.unknown()).nullable().optional(),
      })
      .passthrough()
      .parse(parsed);
    if (envelope.success === false || envelope.errors?.length) {
      throw new CodeSandboxRequestError(response.status);
    }
    return envelope.data ?? parsed;
  }
}
