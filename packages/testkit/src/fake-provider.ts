import {
  ProviderError,
  resolveProviderResources,
  type ProviderCreateSandboxInput,
  type ProviderSandbox,
  type ProviderSandboxCost,
  type ProviderSandboxCostInput,
  type SandboxProvider,
  type SandboxProviderName,
} from "@openmetal/provider-core";

export type FakeProviderBehavior = {
  failures?: Array<{
    kind: ConstructorParameters<typeof ProviderError>[1];
    retryable: boolean;
  }>;
  unknownCreatesResource?: boolean;
};

export class FakeSandboxProvider implements SandboxProvider {
  readonly capabilities = {
    pause: true,
    resume: true,
    cost: true,
    sizing: "direct",
    sources: ["environment", "oci_image", "provider_template"],
  } as const;
  readonly resources = new Map<string, ProviderSandbox & { paused: boolean }>();
  private failures: FakeProviderBehavior["failures"];

  constructor(
    readonly name: SandboxProviderName = "e2b",
    private readonly behavior: FakeProviderBehavior = {},
  ) {
    this.failures = [...(behavior.failures ?? [])];
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const existing = this.resources.get(input.metalSandboxId);
    if (existing) return existing;
    const failure = this.failures?.shift();
    if (failure) {
      if (failure.kind === "unknown_outcome" && this.behavior.unknownCreatesResource) {
        this.resources.set(input.metalSandboxId, this.makeResource(input));
      }
      throw new ProviderError("injected provider failure", failure.kind, failure.retryable);
    }
    const resource = this.makeResource(input);
    this.resources.set(input.metalSandboxId, resource);
    return resource;
  }

  async reconcileCreate(metalSandboxId: string): Promise<ProviderSandbox | null> {
    return this.resources.get(metalSandboxId) ?? null;
  }

  async pause(providerResourceId: string): Promise<void> {
    const resource = this.find(providerResourceId);
    resource.paused = true;
  }

  async resume(providerResourceId: string): Promise<ProviderSandbox> {
    const resource = this.find(providerResourceId);
    resource.paused = false;
    return resource;
  }

  async destroy(providerResourceId: string): Promise<void> {
    for (const [key, resource] of this.resources) {
      if (resource.providerResourceId === providerResourceId) {
        this.resources.delete(key);
      }
    }
  }

  async getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost> {
    return {
      amountMicrousd: BigInt(Math.max(0, input.to.getTime() - input.from.getTime())),
      providerOrganizationId: input.providerOrganizationId ?? "fake-account",
      measuredThrough: input.to,
      raw: { fake: true },
    };
  }

  private makeResource(input: ProviderCreateSandboxInput) {
    return {
      providerResourceId: `fake-${input.metalSandboxId}`,
      providerOrganizationId: "fake-account",
      providerMetadata: { metalSandboxId: input.metalSandboxId },
      resolvedResources: resolveProviderResources(
        this.name,
        input.resources,
        input.providerOptions,
      ),
      paused: false,
    };
  }

  private find(providerResourceId: string) {
    const resource = [...this.resources.values()].find(
      (candidate) => candidate.providerResourceId === providerResourceId,
    );
    if (!resource) throw new Error("fake resource not found");
    return resource;
  }
}
