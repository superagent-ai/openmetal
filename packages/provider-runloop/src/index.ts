import { z } from "zod";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

const DevboxStatusSchema = z.enum([
  "scheduled",
  "queued",
  "provisioning",
  "initializing",
  "running",
  "suspending",
  "suspended",
  "resuming",
  "failure",
  "shutdown",
]);

const DevboxSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    status: DevboxStatusSchema,
    create_time_ms: z.number(),
    end_time_ms: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.string()),
    launch_parameters: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const DevboxListSchema = z
  .object({
    devboxes: z.array(DevboxSchema),
    has_more: z.boolean(),
  })
  .passthrough();

const DevboxUsageSchema = z
  .object({
    id: z.string().min(1),
    total_active_seconds: z.number().int().nonnegative(),
    total_elapsed_seconds: z.number().int().nonnegative(),
    vcpu_seconds: z.number().int().nonnegative(),
    memory_gb_seconds: z.number().int().nonnegative(),
    disk_gb_seconds: z.number().int().nonnegative(),
    start_time_ms: z.number(),
    end_time_ms: z.number().nullable().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const ResourceSizeSchema = z.enum(["X_SMALL", "SMALL", "MEDIUM", "LARGE", "X_LARGE", "XX_LARGE"]);
export type RunloopResourceSize = z.infer<typeof ResourceSizeSchema>;

const hourlyRateMicrousd: Record<RunloopResourceSize, bigint> = {
  X_SMALL: 80_600n,
  SMALL: 159_800n,
  MEDIUM: 319_500n,
  LARGE: 423_100n,
  X_LARGE: 840_700n,
  XX_LARGE: 1_676_000n,
};

export type RunloopSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  resourceSize?: RunloopResourceSize;
  blueprintId?: string;
  usageRatesMicrousd?: {
    vcpuHour: bigint;
    memoryGbHour: bigint;
    diskGbHour: bigint;
  };
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class RunloopRequestError extends Error {
  constructor(readonly status: number) {
    super(`Runloop request failed (${status})`);
  }
}

export class RunloopSandboxProvider implements SandboxProvider {
  readonly name = "runloop" as const;
  readonly capabilities = { pause: true, cost: true } as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly resourceSize: RunloopResourceSize;
  private readonly blueprintId?: string;
  private readonly usageRatesMicrousd?: {
    vcpuHour: bigint;
    memoryGbHour: bigint;
    diskGbHour: bigint;
  };
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private accountId?: string;

  constructor(options: RunloopSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? "https://api.runloop.ai").replace(/\/$/, "");
    this.resourceSize = ResourceSizeSchema.parse(options.resourceSize ?? "SMALL");
    this.blueprintId = options.blueprintId;
    this.usageRatesMicrousd = options.usageRatesMicrousd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 35_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const existing = await this.findByMetalSandboxId(input.metalSandboxId, input.signal);
    const devbox =
      existing ??
      DevboxSchema.parse(
        await this.request("/v1/devboxes", {
          method: "POST",
          body: JSON.stringify({
            name: `metal-${input.metalSandboxId}`,
            metadata: {
              "metal.organization_id": input.organizationId,
              "metal.project_id": input.projectId,
              "metal.sandbox_id": input.metalSandboxId,
            },
            ...(input.image
              ? { blueprint_name: input.image }
              : this.blueprintId
                ? { blueprint_id: this.blueprintId }
                : {}),
            launch_parameters: {
              resource_size_request: this.resourceSize,
              keep_alive_time_seconds: Math.min(input.ttlMinutes * 60, 172_800),
            },
          }),
          signal: input.signal,
        }),
      );
    if (devbox.status === "failure" || devbox.status === "shutdown") {
      throw new Error(`Runloop Devbox entered ${devbox.status}`);
    }
    const ready =
      devbox.status === "running"
        ? devbox
        : await this.waitForStatus(devbox.id, ["running", "failure", "shutdown"], input.signal);
    if (ready.status !== "running") {
      throw new Error(`Runloop Devbox entered ${ready.status}`);
    }
    return {
      providerResourceId: ready.id,
      providerOrganizationId: await this.resolveAccountId(input.signal),
      providerMetadata: {
        runloop: ready,
        resourceSize: this.resourceSize,
        hourlyRateMicrousd: hourlyRateMicrousd[this.resourceSize].toString(),
        ...(this.usageRatesMicrousd
          ? {
              usageRatesMicrousd: {
                vcpuHour: this.usageRatesMicrousd.vcpuHour.toString(),
                memoryGbHour: this.usageRatesMicrousd.memoryGbHour.toString(),
                diskGbHour: this.usageRatesMicrousd.diskGbHour.toString(),
              },
            }
          : {}),
      },
    };
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    const response = DevboxSchema.parse(
      await this.request(`/v1/devboxes/${encodeURIComponent(providerResourceId)}/suspend`, {
        method: "POST",
        signal,
      }),
    );
    if (response.status !== "suspended") {
      const suspended = await this.waitForStatus(
        providerResourceId,
        ["suspended", "failure", "shutdown"],
        signal,
      );
      if (suspended.status !== "suspended") {
        throw new Error(`Runloop Devbox entered ${suspended.status}`);
      }
    }
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    const current = await this.getDevbox(providerResourceId, signal, true);
    if (!current || current.status === "shutdown") {
      return;
    }
    await this.request(
      `/v1/devboxes/${encodeURIComponent(providerResourceId)}/shutdown?force=true`,
      {
        method: "POST",
        signal,
        allowNotFound: true,
      },
    );
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const response = await this.request(
      `/v1/devboxes/${encodeURIComponent(input.providerResourceId)}/usage`,
      {
        method: "GET",
        signal: input.signal,
        allowNotFound: true,
      },
    );
    if (!response) {
      return null;
    }
    const usage = DevboxUsageSchema.parse(response);
    const metadataRate = input.providerMetadata?.hourlyRateMicrousd;
    const rate =
      typeof metadataRate === "string" && /^\d+$/.test(metadataRate)
        ? BigInt(metadataRate)
        : hourlyRateMicrousd[this.resourceSize];
    const metadataUsageRates = input.providerMetadata?.usageRatesMicrousd;
    const usageRates =
      typeof metadataUsageRates === "object" &&
      metadataUsageRates !== null &&
      "vcpuHour" in metadataUsageRates &&
      "memoryGbHour" in metadataUsageRates &&
      "diskGbHour" in metadataUsageRates &&
      typeof metadataUsageRates.vcpuHour === "string" &&
      typeof metadataUsageRates.memoryGbHour === "string" &&
      typeof metadataUsageRates.diskGbHour === "string" &&
      /^\d+$/.test(metadataUsageRates.vcpuHour) &&
      /^\d+$/.test(metadataUsageRates.memoryGbHour) &&
      /^\d+$/.test(metadataUsageRates.diskGbHour)
        ? {
            vcpuHour: BigInt(metadataUsageRates.vcpuHour),
            memoryGbHour: BigInt(metadataUsageRates.memoryGbHour),
            diskGbHour: BigInt(metadataUsageRates.diskGbHour),
          }
        : this.usageRatesMicrousd;
    const componentCostNumerator = usageRates
      ? BigInt(usage.vcpu_seconds) * usageRates.vcpuHour +
        BigInt(usage.memory_gb_seconds) * usageRates.memoryGbHour +
        BigInt(usage.disk_gb_seconds) * usageRates.diskGbHour
      : undefined;
    return {
      amountMicrousd:
        componentCostNumerator === undefined
          ? (BigInt(usage.total_active_seconds) * rate + 1_800n) / 3_600n
          : (componentCostNumerator + 1_800n) / 3_600n,
      providerOrganizationId:
        input.providerOrganizationId ?? (await this.resolveAccountId(input.signal)),
      measuredThrough: usage.end_time_ms ? new Date(usage.end_time_ms) : input.to,
      raw: {
        source: usageRates
          ? "runloop-resource-usage-oem-rate-card"
          : "runloop-resource-usage-published-preset-rate",
        resourceSize: input.providerMetadata?.resourceSize ?? this.resourceSize,
        hourlyRateMicrousd: rate.toString(),
        usageRatesMicrousd: usageRates
          ? {
              vcpuHour: usageRates.vcpuHour.toString(),
              memoryGbHour: usageRates.memoryGbHour.toString(),
              diskGbHour: usageRates.diskGbHour.toString(),
            }
          : null,
        suspendedStorageCostIncluded: Boolean(usageRates),
        usage,
      },
    };
  }

  private async resolveAccountId(signal?: AbortSignal): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const account = z
      .object({ id: z.string().min(1) })
      .passthrough()
      .parse(
        await this.request("/v1/accounts/me", {
          method: "GET",
          signal,
        }),
      );
    this.accountId = account.id;
    return account.id;
  }

  private async findByMetalSandboxId(
    metalSandboxId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof DevboxSchema> | undefined> {
    let startingAfter: string | undefined;
    do {
      const query = new URLSearchParams({
        limit: "5000",
        include_total_count: "false",
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const result = DevboxListSchema.parse(
        await this.request(`/v1/devboxes?${query}`, {
          method: "GET",
          signal,
        }),
      );
      const existing = result.devboxes.find(
        (devbox) =>
          (devbox.metadata["metal.sandbox_id"] === metalSandboxId ||
            devbox.metadata.metal_sandbox_id === metalSandboxId) &&
          devbox.status !== "failure" &&
          devbox.status !== "shutdown",
      );
      if (existing) {
        return existing;
      }
      startingAfter = result.has_more ? result.devboxes.at(-1)?.id : undefined;
    } while (startingAfter);
    return undefined;
  }

  private async getDevbox(
    id: string,
    signal?: AbortSignal,
    allowNotFound = false,
  ): Promise<z.infer<typeof DevboxSchema> | null> {
    const response = await this.request(`/v1/devboxes/${encodeURIComponent(id)}`, {
      method: "GET",
      signal,
      allowNotFound,
    });
    return response ? DevboxSchema.parse(response) : null;
  }

  private async waitForStatus(
    id: string,
    statuses: Array<z.infer<typeof DevboxStatusSchema>>,
    callerSignal?: AbortSignal,
  ): Promise<z.infer<typeof DevboxSchema>> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request(
        `/v1/devboxes/${encodeURIComponent(id)}/wait_for_status`,
        {
          method: "POST",
          body: JSON.stringify({
            statuses,
            timeout_seconds: Math.min(30, Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))),
          }),
          signal: callerSignal,
          allowTimeout: true,
        },
      );
      if (response) {
        return DevboxSchema.parse(response);
      }
    }
    throw new Error("Runloop Devbox did not reach the requested status");
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowNotFound?: boolean;
      allowTimeout?: boolean;
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
    if (
      (options.allowNotFound && response.status === 404) ||
      (options.allowTimeout && response.status === 408)
    ) {
      return null;
    }
    if (!response.ok) {
      throw new RunloopRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
