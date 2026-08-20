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
};

export type ProviderSandboxCostInput = {
  providerResourceId: string;
  providerOrganizationId?: string;
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

export interface SandboxProvider {
  readonly name: "daytona";
  create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox>;
  getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null>;
  pause(providerResourceId: string, signal?: AbortSignal): Promise<void>;
  destroy(providerResourceId: string, signal?: AbortSignal): Promise<void>;
}
