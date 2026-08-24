import { z } from "zod";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

export type CloudflareSandboxProviderOptions = {
  apiUrl: string;
  apiKey: string;
  accountId?: string;
  analyticsToken?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class CloudflareRequestError extends Error {
  constructor(readonly status: number) {
    super(`Cloudflare Sandbox bridge request failed (${status})`);
  }
}

const AnalyticsGroupSchema = z.object({
  dimensions: z.object({
    instanceId: z.string(),
    region: z.string(),
  }),
  sum: z.object({
    cpuTimeSec: z.number().nonnegative(),
    allocatedMemory: z.number().nonnegative(),
    allocatedDisk: z.number().nonnegative(),
    txBytes: z.number().nonnegative(),
  }),
});

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare" as const;
  readonly capabilities: SandboxProvider["capabilities"];
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly accountId?: string;
  private readonly analyticsToken?: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly createdByMetalId = new Map<string, string>();

  constructor(options: CloudflareSandboxProviderOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.accountId = options.accountId;
    this.analyticsToken = options.analyticsToken;
    this.capabilities = {
      pause: false,
      cost: Boolean(options.accountId && options.analyticsToken),
      sizing: "fixed",
      sources: ["environment"],
    };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("cloudflare", input.resources, input.providerOptions);
    let sandboxId = this.createdByMetalId.get(input.metalSandboxId);
    if (!sandboxId) {
      const created = z.object({ id: z.string().min(1) }).parse(
        await this.request("/v1/sandbox", {
          method: "POST",
          signal: input.signal,
        }),
      );
      sandboxId = created.id;
      this.createdByMetalId.set(input.metalSandboxId, sandboxId);
    }
    const instanceId = await this.waitUntilRunning(sandboxId, input.signal);
    return {
      providerResourceId: sandboxId,
      providerOrganizationId: new URL(this.apiUrl).host,
      providerMetadata: {
        bridgeUrl: this.apiUrl,
        containerUuid: instanceId,
        metalSandboxId: input.metalSandboxId,
      },
      resolvedResources: resolved,
    };
  }

  async pause(): Promise<void> {
    throw new Error("Cloudflare Sandboxes do not support explicit pause");
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/v1/sandbox/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    if (!this.accountId || !this.analyticsToken) {
      return null;
    }
    const query = `
      query ContainerUsage(
        $accountTag: String
        $datetimeStart: Time
        $datetimeEnd: Time
        $label: String
      ) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            usage: containersUsageAdaptiveGroups(
              limit: 100
              filter: {
                datetime_geq: $datetimeStart
                datetime_leq: $datetimeEnd
                labels_has: $label
              }
            ) {
              dimensions { instanceId region }
              sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
            }
            metrics: containersMetricsAdaptiveGroups(
              limit: 100
              filter: {
                datetime_geq: $datetimeStart
                datetime_leq: $datetimeEnd
                labels_has: $label
              }
            ) {
              dimensions { instanceId region }
              sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
            }
          }
        }
      }
    `;
    const response = await this.fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.analyticsToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: this.accountId,
          datetimeStart: input.from.toISOString(),
          datetimeEnd: input.to.toISOString(),
          label: `metal_sbx=${input.providerResourceId}`,
        },
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new CloudflareRequestError(response.status);
    }
    const parsed = z
      .object({
        data: z
          .object({
            viewer: z.object({
              accounts: z.array(
                z.object({
                  usage: z.array(AnalyticsGroupSchema),
                  metrics: z.array(AnalyticsGroupSchema),
                }),
              ),
            }),
          })
          .nullable(),
        errors: z
          .array(z.object({ message: z.string() }))
          .optional()
          .nullable(),
      })
      .parse(await response.json());
    if (parsed.errors?.length) {
      throw new Error(`Cloudflare Analytics: ${parsed.errors[0]!.message}`);
    }
    const accounts = parsed.data?.viewer.accounts ?? [];
    const usageRows = accounts.flatMap((account) => account.usage);
    const rows = usageRows.length > 0 ? usageRows : accounts.flatMap((account) => account.metrics);
    if (rows.length === 0) {
      return null;
    }
    let amountMicrousd = 0;
    for (const row of rows) {
      amountMicrousd += row.sum.cpuTimeSec * 20;
      amountMicrousd += (row.sum.allocatedMemory / 2 ** 30) * 2.5;
      amountMicrousd += (row.sum.allocatedDisk / 1_000_000_000) * 0.07;
      amountMicrousd +=
        (row.sum.txBytes / 1_000_000_000) * this.egressUsdPerGb(row.dimensions.region) * 1_000_000;
    }
    return {
      amountMicrousd: BigInt(Math.round(amountMicrousd)),
      providerOrganizationId: this.accountId,
      measuredThrough: input.to,
      raw: {
        source:
          usageRows.length > 0
            ? "cloudflare-containers-usage"
            : "cloudflare-containers-metrics-estimate",
        rateCardVersion: "2026-04-21",
        bridgeSandboxId: input.providerResourceId,
        rows,
      },
    };
  }

  private async waitUntilRunning(sandboxId: string, callerSignal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const result = z.object({ running: z.boolean(), instanceId: z.string().min(1) }).parse(
        await this.request(`/v1/sandbox/${encodeURIComponent(sandboxId)}/running`, {
          method: "GET",
          signal: callerSignal,
        }),
      );
      if (result.running) {
        return result.instanceId;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Cloudflare Sandbox did not become ready");
  }

  private egressUsdPerGb(region: string): number {
    const normalized = region.toLowerCase();
    if (normalized.includes("nam") || normalized.includes("eur")) {
      return 0.025;
    }
    if (normalized.includes("oce") || normalized.includes("kor") || normalized.includes("twn")) {
      return 0.05;
    }
    return 0.04;
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
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
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
      signal,
    });
    if (options.allowNotFound && response.status === 404) {
      return {};
    }
    if (!response.ok) {
      throw new CloudflareRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
