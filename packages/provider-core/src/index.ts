export type ProviderCreateSandboxInput = {
  metalSandboxId: string;
  organizationId: string;
  projectId: string;
  image?: string;
  language: string;
  ttlMinutes: number;
  source: {
    kind: "environment" | "oci_image" | "provider_template";
    environment?: string;
    version?: string;
    image?: string;
    template?: string;
    command?: string[];
  };
  resources: {
    vcpu: number;
    memoryMb: number;
    diskMb?: number;
    architecture: "x86_64" | "arm64" | "any";
  };
  lifecycle: {
    runtimeTimeoutSeconds: number;
    idleTimeoutSeconds?: number;
    onRuntimeTimeout: "destroy" | "pause";
    onIdleTimeout: "destroy" | "pause";
  };
  providerOptions?: Record<string, unknown>;
  environment?: Record<string, string>;
  secretRefs?: Record<string, string>;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
};

export type ProviderSandbox = {
  providerResourceId: string;
  providerOrganizationId: string;
  providerMetadata?: Record<string, unknown>;
  resolvedResources?: {
    vcpu: number;
    memoryMb: number;
    diskMb: number | null;
    architecture: "x86_64" | "arm64";
    providerSize: string | null;
  };
};

export type ProviderSandboxCostInput = {
  providerResourceId: string;
  providerOrganizationId?: string;
  providerMetadata?: Record<string, unknown>;
  from: Date;
  to: Date;
  signal?: AbortSignal;
};

export type ProviderCostProvenance =
  "provider_reported" | "provider_metered" | "estimated_rate_card";

export type ProviderCostConfidence = "high" | "medium" | "low";

export type ProviderSandboxCost = {
  amountMicrousd: bigint;
  providerOrganizationId: string;
  measuredThrough: Date;
  provenance: ProviderCostProvenance;
  confidence: ProviderCostConfidence;
  source: string;
  rateCardVersion?: string;
  raw: Record<string, unknown>;
};

export type ProviderDestroyResult = {
  providerMetadata?: Record<string, unknown>;
};

export type ProviderRuntimeOperation = {
  deadline?: Date;
  signal?: AbortSignal;
};

export type ProviderExecInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  command: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  stdin?: string | Uint8Array;
  maxOutputBytes?: number;
};

export type ProviderExecOutputEvent = {
  type: "stdout" | "stderr";
  sequence: number;
  data: Uint8Array;
  truncated?: boolean;
};

export type ProviderExecExitEvent = {
  type: "exit";
  sequence: number;
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  outputTruncated: boolean;
};

export type ProviderExecEvent = ProviderExecOutputEvent | ProviderExecExitEvent;

export type ProviderExecResult = {
  executionId: string;
  events: AsyncIterable<ProviderExecEvent>;
};

export type ProviderCancelExecInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  executionId: string;
};

export type ProviderCancelExecResult = {
  executionId: string;
  cancelled: boolean;
};

export type ProviderFileEncoding = "binary" | "utf8";
export type ProviderFileWriteMode = "create" | "overwrite" | "append";

export type ProviderReadFileInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  path: string;
  encoding?: ProviderFileEncoding;
  offsetBytes?: number;
  maxBytes?: number;
};

export type ProviderReadFileResult = {
  path: string;
  encoding: ProviderFileEncoding;
  data: Uint8Array | string;
  offsetBytes: number;
  byteLength: number;
  sizeBytes: number;
  eof: boolean;
  truncated: boolean;
};

export type ProviderWriteFileInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  path: string;
  data: Uint8Array | string;
  mode?: ProviderFileWriteMode;
  createParents?: boolean;
};

export type ProviderWriteFileResult = {
  path: string;
  bytesWritten: number;
  created: boolean;
};

export type ProviderListFilesInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  path: string;
  recursive?: boolean;
  maxEntries?: number;
};

export type ProviderFileEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number | null;
  modifiedAt: Date | null;
};

export type ProviderListFilesResult = {
  entries: ProviderFileEntry[];
  truncated: boolean;
};

export type ProviderDeleteFileInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  path: string;
  recursive?: boolean;
};

export type ProviderDeleteFileResult = {
  path: string;
  deleted: boolean;
};

export type ProviderExposeHttpEndpointInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  port: number;
  path?: string;
  leaseDurationSeconds: number;
};

export type ProviderHttpEndpointLease = {
  leaseId: string;
  url: string;
  expiresAt: Date;
};

export type ProviderRevokeHttpEndpointInput = ProviderRuntimeOperation & {
  providerResourceId: string;
  leaseId: string;
};

export type ProviderRevokeHttpEndpointResult = {
  leaseId: string;
  revoked: boolean;
};

export type ProviderProcessCapabilities = {
  exec: boolean;
  streams: boolean;
  cancel: boolean;
  maxOutputBytes: number;
};

export type ProviderFileCapabilities = {
  read: boolean;
  write: boolean;
  writeModes: readonly ProviderFileWriteMode[];
  createParents: boolean;
  list: boolean;
  delete: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
};

export type ProviderHttpEndpointCapabilities = {
  expose: boolean;
  revoke: boolean;
  maxLeaseDurationSeconds?: number;
};

export type ProviderRuntimeCapabilities = {
  process?: ProviderProcessCapabilities;
  files?: ProviderFileCapabilities;
  httpEndpoints?: ProviderHttpEndpointCapabilities;
};

export interface ProviderProcessRuntime {
  exec(input: ProviderExecInput): Promise<ProviderExecResult>;
  cancelExec?(input: ProviderCancelExecInput): Promise<ProviderCancelExecResult>;
}

export interface ProviderFileRuntime {
  readFile?(input: ProviderReadFileInput): Promise<ProviderReadFileResult>;
  writeFile?(input: ProviderWriteFileInput): Promise<ProviderWriteFileResult>;
  listFiles?(input: ProviderListFilesInput): Promise<ProviderListFilesResult>;
  deleteFile?(input: ProviderDeleteFileInput): Promise<ProviderDeleteFileResult>;
}

export interface ProviderHttpEndpointRuntime {
  exposeHttpEndpoint?(input: ProviderExposeHttpEndpointInput): Promise<ProviderHttpEndpointLease>;
  revokeHttpEndpoint?(
    input: ProviderRevokeHttpEndpointInput,
  ): Promise<ProviderRevokeHttpEndpointResult>;
}

export interface SandboxRuntimeProvider
  extends Partial<ProviderProcessRuntime>, ProviderFileRuntime, ProviderHttpEndpointRuntime {}

export type SandboxProviderName =
  | "blaxel"
  | "cloudflare"
  | "codesandbox"
  | "daytona"
  | "e2b"
  | "freestyle"
  | "modal"
  | "northflank"
  | "runloop"
  | "vercel";

export type SandboxProviderCapabilities = {
  pause: boolean;
  cost: boolean;
  resume?: boolean;
  sizing?: "direct" | "tier" | "template" | "fixed";
  sources?: ReadonlyArray<"environment" | "oci_image" | "provider_template">;
  runtime?: ProviderRuntimeCapabilities;
};

export interface SandboxProvider extends SandboxRuntimeProvider {
  readonly name: SandboxProviderName;
  readonly capabilities: SandboxProviderCapabilities;
  create(input: ProviderCreateSandboxInput): Promise<ProviderSandbox>;
  getCost(input: ProviderSandboxCostInput): Promise<ProviderSandboxCost | null>;
  pause(providerResourceId: string, signal?: AbortSignal): Promise<void>;
  resume?(providerResourceId: string, signal?: AbortSignal): Promise<ProviderSandbox | void>;
  reconcileCreate?(metalSandboxId: string, signal?: AbortSignal): Promise<ProviderSandbox | null>;
  destroy(providerResourceId: string, signal?: AbortSignal): Promise<ProviderDestroyResult | void>;
}

export type ProviderFailureKind =
  | "auth"
  | "quota"
  | "capacity"
  | "unavailable"
  | "timeout_absent"
  | "unknown_outcome"
  | "invalid_request"
  | "unsupported"
  | "customer";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const runloopSizes = [
  ["X_SMALL", 0.5, 1024, 4096],
  ["SMALL", 1, 2048, 4096],
  ["MEDIUM", 2, 4096, 8192],
  ["LARGE", 2, 8192, 16_384],
  ["X_LARGE", 4, 16_384, 16_384],
  ["XX_LARGE", 8, 32_768, 16_384],
] as const;

const codeSandboxSizes = [
  ["Pico", 2, 1024],
  ["Nano", 2, 4096],
  ["Micro", 4, 8192],
  ["Small", 8, 16_384],
  ["Medium", 16, 32_768],
  ["Large", 32, 65_536],
  ["XLarge", 64, 131_072],
] as const;

export function resolveProviderResources(
  provider: SandboxProviderName,
  requested: ProviderCreateSandboxInput["resources"],
  providerOptions: Record<string, unknown> = {},
): NonNullable<ProviderSandbox["resolvedResources"]> {
  if (provider === "runloop") {
    const selected = runloopSizes.find(
      ([, cpu, memory, disk]) =>
        cpu >= requested.vcpu && memory >= requested.memoryMb && disk >= (requested.diskMb ?? 0),
    );
    if (!selected) {
      throw new ProviderError("Runloop cannot satisfy requested resources", "unsupported", false);
    }
    return {
      vcpu: selected[1],
      memoryMb: selected[2],
      diskMb: selected[3],
      architecture: requested.architecture === "arm64" ? "arm64" : "x86_64",
      providerSize: String(providerOptions.resource_size ?? selected[0]),
    };
  }
  if (provider === "codesandbox") {
    const selected = codeSandboxSizes.find(
      ([, cpu, memory]) => cpu >= requested.vcpu && memory >= requested.memoryMb,
    );
    if (!selected) {
      throw new ProviderError(
        "CodeSandbox cannot satisfy requested resources",
        "unsupported",
        false,
      );
    }
    return {
      vcpu: selected[1],
      memoryMb: selected[2],
      diskMb: requested.diskMb ?? null,
      architecture: "x86_64",
      providerSize: String(providerOptions.vm_tier ?? selected[0]),
    };
  }
  if (requested.architecture === "arm64" && !["modal", "northflank"].includes(provider)) {
    throw new ProviderError(`${provider} arm64 support is not verified`, "unsupported", false);
  }
  return {
    vcpu: requested.vcpu,
    memoryMb: requested.memoryMb,
    diskMb: requested.diskMb ?? null,
    architecture: requested.architecture === "arm64" ? "arm64" : "x86_64",
    providerSize: typeof providerOptions.size === "string" ? providerOptions.size : null,
  };
}

const environments = {
  "metal/base": { language: "typescript", image: undefined },
  "metal/node": { language: "typescript", image: undefined },
  "metal/python": { language: "python", image: undefined },
} as const;

export function resolveMetalEnvironment(source: ProviderCreateSandboxInput["source"]): {
  language: string;
  image?: string;
} {
  if (source.kind === "oci_image") {
    if (!source.image) throw new ProviderError("OCI image is required", "invalid_request", false);
    return { language: "custom", image: source.image };
  }
  if (source.kind === "provider_template") {
    if (!source.template) {
      throw new ProviderError("provider template is required", "invalid_request", false);
    }
    return { language: "custom", image: source.template };
  }
  const environment = source.environment
    ? environments[source.environment as keyof typeof environments]
    : undefined;
  if (!environment) {
    throw new ProviderError(
      `unknown Metal environment: ${source.environment ?? ""}`,
      "invalid_request",
      false,
    );
  }
  return environment;
}

export const MetalEnvironmentCatalog = environments;
