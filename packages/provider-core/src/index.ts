export type ProviderCreateSandboxInput = {
  metalSandboxId: string;
  organizationId: string;
  projectId: string;
  image?: string;
  language: string;
  ttlMinutes: number;
  signal?: AbortSignal;
};

export type ProviderSandbox = {
  providerResourceId: string;
  providerOrganizationId: string;
  providerMetadata?: Record<string, unknown>;
};

export type ProviderSandboxCostInput = {
  providerResourceId: string;
  providerOrganizationId?: string;
  providerMetadata?: Record<string, unknown>;
  from: Date;
  to: Date;
  signal?: AbortSignal;
};

export type ProviderSandboxCost = {
  amountMicrousd: bigint;
  providerOrganizationId: string;
  measuredThrough: Date;
  raw: Record<string, unknown>;
};

export type ProviderDestroyResult = {
  providerMetadata?: Record<string, unknown>;
};

export type SandboxProviderName =
  | "blaxel"
  | "cloudflare"
  | "codesandbox"
  | "daytona"
  | "e2b"
  | "modal"
  | "northflank"
  | "runloop"
  | "vercel";

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly capabilities: {
    pause: boolean;
    cost: boolean;
  };
  create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox>;
  getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null>;
  pause(providerResourceId: string, signal?: AbortSignal): Promise<void>;
  destroy(providerResourceId: string, signal?: AbortSignal): Promise<ProviderDestroyResult | void>;
}
