import { z } from "zod";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

const ServiceEnvelopeSchema = z
  .object({
    data: z
      .object({
        name: z.string().min(1),
        status: z
          .object({
            deployment: z
              .object({
                status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"]),
                reason: z.string().optional(),
                lastTransitionTime: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

type JsonRecord = Record<string, unknown>;

export type NorthflankSandboxProviderOptions = {
  apiToken: string;
  projectId: string;
  teamId?: string;
  apiUrl?: string;
  deploymentPlan?: string;
  defaultImage?: string;
  ephemeralStorageMb?: number;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

class NorthflankRequestError extends Error {
  constructor(readonly status: number) {
    super(`Northflank request failed (${status})`);
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function findResourceCost(
  value: unknown,
  providerResourceId: string,
): { amountCents: number; resource: JsonRecord } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findResourceCost(item, providerResourceId);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const price = asRecord(record.price);
  if (
    (record.id === providerResourceId || record.name === providerResourceId) &&
    typeof price?.total === "number"
  ) {
    return {
      amountCents: price.total,
      resource: record,
    };
  }
  for (const child of Object.values(record)) {
    const match = findResourceCost(child, providerResourceId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export class NorthflankSandboxProvider implements SandboxProvider {
  readonly name = "northflank" as const;
  readonly capabilities = { pause: true, cost: true } as const;
  private readonly apiToken: string;
  private readonly projectId: string;
  private readonly teamId?: string;
  private readonly apiUrl: string;
  private readonly deploymentPlan: string;
  private readonly defaultImage: string;
  private readonly ephemeralStorageMb: number;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NorthflankSandboxProviderOptions) {
    this.apiToken = options.apiToken;
    this.projectId = options.projectId;
    this.teamId = options.teamId;
    this.apiUrl = (options.apiUrl ?? "https://api.northflank.com/v1").replace(/\/$/, "");
    this.deploymentPlan = options.deploymentPlan ?? "nf-compute-200";
    this.defaultImage = options.defaultImage ?? "ubuntu:22.04";
    this.ephemeralStorageMb = options.ephemeralStorageMb ?? 2_048;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const serviceId = `metal-${input.metalSandboxId}`;
    const response = await this.request(`${this.projectPath()}/services/deployment`, {
      method: "POST",
      body: JSON.stringify({
        name: serviceId,
        description: `Metal sandbox ${input.metalSandboxId}`,
        billing: {
          deploymentPlan: this.deploymentPlan,
        },
        deployment: {
          instances: 1,
          docker: {
            configType: "customCommand",
            customCommand: "sleep infinity",
          },
          external: {
            imagePath: input.image ?? this.defaultImage,
          },
          storage: {
            ephemeralStorage: {
              storageSize: this.ephemeralStorageMb,
            },
          },
        },
        createOptions: {
          expiryTime: Math.max(300, Math.min(604_800, input.ttlMinutes * 60)),
        },
      }),
      signal: input.signal,
      allowConflict: true,
    });
    const created = response ? ServiceEnvelopeSchema.parse(response).data : undefined;
    const ready = await this.waitUntilReady(serviceId, input.signal);
    return {
      providerResourceId: serviceId,
      providerOrganizationId: this.teamId ?? this.projectId,
      providerMetadata: {
        northflank: ready,
        projectId: this.projectId,
        teamId: this.teamId,
        deploymentPlan: this.deploymentPlan,
        createdStatus: created?.status?.deployment?.status,
      },
    };
  }

  async pause(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      `${this.projectPath()}/services/${encodeURIComponent(providerResourceId)}/pause`,
      {
        method: "POST",
        signal,
      },
    );
  }

  async destroy(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      `${this.projectPath()}/services/${encodeURIComponent(providerResourceId)}?delete_child_objects=true`,
      {
        method: "DELETE",
        signal,
        allowNotFound: true,
      },
    );
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    const hourMs = 60 * 60_000;
    const firstHour = Math.floor(input.from.getTime() / hourMs) * hourMs;
    const lastHour = Math.floor(input.to.getTime() / hourMs) * hourMs;
    let totalCents = 0;
    let matched = false;
    const rawHours: JsonRecord[] = [];

    for (let hour = firstHour; hour <= lastHour; hour += hourMs) {
      for (let page = 1; page <= 100; page += 1) {
        const query = new URLSearchParams({
          resourceType: "service",
          per_page: "100",
          page: String(page),
        });
        const response = await this.request(
          `${this.billingPath()}/${Math.floor(hour / 1_000)}?${query}`,
          {
            method: "GET",
            signal: input.signal,
            allowNotFound: true,
          },
        );
        const record = asRecord(response);
        if (!record) {
          break;
        }
        rawHours.push(record);
        const cost = findResourceCost(record, input.providerResourceId);
        if (cost) {
          matched = true;
          totalCents += cost.amountCents;
          break;
        }
        const pagination = asRecord(record.pagination);
        if (pagination?.hasNextPage !== true) {
          break;
        }
      }
    }

    if (!matched) {
      return null;
    }
    return {
      amountMicrousd: BigInt(Math.round(totalCents * 10_000)),
      providerOrganizationId: this.teamId ?? this.projectId,
      measuredThrough: input.to,
      raw: {
        source: "northflank-hourly-billing-usage",
        projectId: this.projectId,
        teamId: this.teamId,
        hours: rawHours,
      },
    };
  }

  private projectPath(): string {
    const projectId = encodeURIComponent(this.projectId);
    return this.teamId
      ? `/teams/${encodeURIComponent(this.teamId)}/projects/${projectId}`
      : `/projects/${projectId}`;
  }

  private billingPath(): string {
    return "/billing/usage";
  }

  private async waitUntilReady(
    serviceId: string,
    callerSignal?: AbortSignal,
  ): Promise<z.infer<typeof ServiceEnvelopeSchema>["data"]> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const service = ServiceEnvelopeSchema.parse(
        await this.request(`${this.projectPath()}/services/${encodeURIComponent(serviceId)}`, {
          method: "GET",
          signal: callerSignal,
        }),
      ).data;
      const status = service.status?.deployment?.status;
      if (status === "COMPLETED") {
        return service;
      }
      if (status === "FAILED") {
        throw new Error("Northflank sandbox deployment failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("Northflank sandbox did not become ready");
  }

  private async request(
    path: string,
    options: {
      method: "DELETE" | "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      allowConflict?: boolean;
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
        authorization: `Bearer ${this.apiToken}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
      signal,
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (options.allowConflict && response.status === 409) {
      const message = asRecord(asRecord(parsed)?.error)?.message;
      if (
        typeof message === "string" &&
        /already (?:a service|exists)|same derived identifier/i.test(message)
      ) {
        return null;
      }
    }
    if (options.allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new NorthflankRequestError(response.status);
    }
    return parsed;
  }
}
