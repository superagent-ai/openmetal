import { AlreadyExistsError, ModalClient, NotFoundError } from "modal";
import { resolveProviderResources } from "@openmetal/provider-core";
import type {
  ProviderCreateSandboxInput,
  ProviderSandbox,
  ProviderSandboxCost,
  ProviderSandboxCostInput,
  SandboxProvider,
} from "@openmetal/provider-core";

export type ModalProviderOptions = {
  tokenId: string;
  tokenSecret: string;
  appName?: string;
  environment?: string;
  requestTimeoutMs?: number;
};

export class ModalSandboxProvider implements SandboxProvider {
  readonly name = "modal" as const;
  readonly capabilities = {
    pause: false,
    cost: false,
    sizing: "fixed",
    sources: ["environment", "oci_image"],
  } as const;
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly environment?: string;

  constructor(options: ModalProviderOptions) {
    this.client = new ModalClient({
      tokenId: options.tokenId,
      tokenSecret: options.tokenSecret,
      environment: options.environment,
      timeoutMs: options.requestTimeoutMs ?? 30_000,
    });
    this.appName = options.appName ?? "metal-sandboxes";
    this.environment = options.environment;
  }

  async create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox> {
    const resolved = resolveProviderResources("modal", input.resources, input.providerOptions);
    const app = await this.client.apps.fromName(this.appName, {
      createIfMissing: true,
      environment: this.environment,
    });
    const image = this.client.images.fromRegistry(input.image ?? this.defaultImage(input.language));
    const name = `metal-${input.metalSandboxId}`;
    let sandbox;
    try {
      sandbox = await this.client.sandboxes.create(app, image, {
        name,
        timeoutMs: input.ttlMinutes * 60_000,
        tags: {
          "metal.sandbox_id": input.metalSandboxId,
          "metal.organization_id": input.organizationId,
          "metal.project_id": input.projectId,
        },
      });
    } catch (error) {
      if (!(error instanceof AlreadyExistsError)) {
        throw error;
      }
      sandbox = await this.client.sandboxes.fromName(this.appName, name, {
        environment: this.environment,
      });
    }
    const check = await sandbox.exec(["true"]);
    const exitCode = await check.wait();
    if (exitCode !== 0) {
      throw new Error(`Modal sandbox readiness check failed (${exitCode})`);
    }
    return {
      providerResourceId: sandbox.sandboxId,
      providerOrganizationId: app.appId,
      resolvedResources: resolved,
    };
  }

  async destroy(providerResourceId: string): Promise<void> {
    try {
      const sandbox = await this.client.sandboxes.fromId(providerResourceId);
      await sandbox.terminate();
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
  }

  async pause(): Promise<void> {
    throw new Error("Modal sandboxes do not support pause");
  }

  async getCost(_input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null> {
    return null;
  }

  private defaultImage(language: string): string {
    if (language === "python") {
      return "python:3.13-slim";
    }
    return "node:22-slim";
  }
}
