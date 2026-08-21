import { z } from "zod";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

const SandboxSchema = z
  .object({
    metadata: z
      .object({
        name: z.string().min(1),
        externalId: z.string().optional(),
        workspace: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough(),
    spec: z.record(z.string(), z.unknown()),
    status: z.string().optional(),
    state: z.enum(["RUNNING", "STANDBY"]).optional(),
  })
  .passthrough();

export type BlaxelSandboxProviderOptions = {
  apiKey: string;
  workspace: string;
  accountId?: string;
  apiUrl?: string;
  apiVersion?: string;
  defaultImage?: string;
  defaultMemoryMb?: number;
  region?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class BlaxelRequestError extends Error {
  constructor(readonly status: number) {
    super(`Blaxel request failed (${status})`);
  }
}

export class BlaxelSandboxProvider implements SandboxProvider {
  readonly name = "blaxel" as const;
  readonly capabilities: { pause: false; cost: boolean };
  private readonly apiKey: string;
  private readonly workspace: string;
  private accountId?: string;
  private readonly apiUrl: string;
  private readonly apiVersion: string;
  private readonly defaultImage: string;
  private readonly defaultMemoryMb: number;
  private readonly region?: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BlaxelSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.workspace = options.workspace;
    this.accountId = options.accountId;
    this.apiUrl = (options.apiUrl ?? "https://api.blaxel.ai/v0").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2026-04-28";
    this.defaultImage = options.defaultImage ?? "blaxel/base-image:latest";
    this.defaultMemoryMb = options.defaultMemoryMb ?? 2_048;
    this.region = options.region;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 65_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilities = { pause: false, cost: true };
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const name = `metal-${input.metalSandboxId}`;
    let created: z.infer<typeof SandboxSchema> | undefined;
    try {
      created = SandboxSchema.parse(
        await this.request("/sandboxes?createIfNotExist=true", {
          method: "POST",
          body: JSON.stringify({
            metadata: {
              name,
              externalId: input.metalSandboxId,
              labels: {
                "metal.organization_id": input.organizationId,
                "metal.project_id": input.projectId,
                "metal.sandbox_id": input.metalSandboxId,
              },
            },
            spec: {
              enabled: true,
              ...(this.region ? { region: this.region } : {}),
              runtime: {
                image: input.image ?? this.defaultImage,
                memory: this.defaultMemoryMb,
                ttl: `${input.ttlMinutes}m`,
              },
            },
          }),
          signal: input.signal,
        }),
      );
    } catch (error) {
      const recoverableCreateTimeout =
        (error instanceof BlaxelRequestError && error.status === 504) ||
        (error instanceof DOMException && error.name === "TimeoutError");
      if (!recoverableCreateTimeout) {
        throw error;
      }
    }
    const ready = await this.waitUntilReady(name, input.signal);
    return {
      providerResourceId: name,
      providerOrganizationId: this.accountId ?? ready.metadata.workspace ?? this.workspace,
      providerMetadata: {
        blaxel: ready,
        createdStatus: created?.status ?? "CREATE_TIMEOUT_RECOVERED",
      },
    };
  }

  async pause(): Promise<void> {
    throw new Error("Blaxel sandboxes use automatic standby");
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(providerResourceId)}`, {
      method: "DELETE",
      signal,
      allowNotFound: true,
    });
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const accountId = await this.resolveAccountId(input.signal);
    const query = new URLSearchParams({
      startTime: input.from.toISOString(),
      endTime: new Date(Math.max(input.to.getTime(), Date.now())).toISOString(),
      resolution: "hourly",
      resourceType: "sandbox",
      resourceName: input.providerResourceId,
    });
    const metrics = z
      .object({
        summary: z.object({ totalCost: z.number().nonnegative() }),
        data: z.array(z.record(z.string(), z.unknown())),
      })
      .passthrough()
      .parse(
        await this.request(`/accounts/${encodeURIComponent(accountId)}/metrics?${query}`, {
          method: "GET",
          signal: input.signal,
        }),
      );
    if (metrics.data.length === 0) {
      return null;
    }
    return {
      amountMicrousd: BigInt(Math.round(metrics.summary.totalCost * 1_000_000)),
      providerOrganizationId: accountId,
      measuredThrough: input.to,
      raw: {
        source: "blaxel-billing-explorer",
        metrics,
      },
    };
  }

  private async resolveAccountId(signal?: AbortSignal): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const workspace = z
      .object({ accountId: z.string().min(1) })
      .passthrough()
      .parse(
        await this.request(`/workspaces/${encodeURIComponent(this.workspace)}`, {
          method: "GET",
          signal,
        }),
      );
    this.accountId = workspace.accountId;
    return workspace.accountId;
  }

  private async waitUntilReady(
    name: string,
    callerSignal?: AbortSignal,
  ): Promise<z.infer<typeof SandboxSchema>> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const sandbox = SandboxSchema.parse(
        await this.request(`/sandboxes/${encodeURIComponent(name)}`, {
          method: "GET",
          signal: callerSignal,
        }),
      );
      if (sandbox.status === "DEPLOYED") {
        return sandbox;
      }
      if (sandbox.status === "FAILED" || sandbox.status === "TERMINATED") {
        throw new Error(`Blaxel sandbox entered ${sandbox.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error("Blaxel sandbox did not become ready");
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
        authorization: `Bearer ${this.apiKey}`,
        "x-blaxel-workspace": this.workspace,
        "blaxel-version": this.apiVersion,
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
      throw new BlaxelRequestError(response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
