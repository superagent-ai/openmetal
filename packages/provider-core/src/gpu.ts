import type { ProviderSandboxCost } from "./index.js";

export type GpuType =
  | "nvidia-t4"
  | "nvidia-l4"
  | "nvidia-a10"
  | "nvidia-l40s"
  | "nvidia-a100-40gb"
  | "nvidia-a100-80gb"
  | "nvidia-rtx-pro-6000"
  | "nvidia-h100"
  | "nvidia-h200"
  | "nvidia-b200"
  | "nvidia-b300";

export type GpuJobProviderName = "modal";

export const GPU_TYPE_CATALOG: Readonly<Record<GpuType, { name: string; vramGb: number }>> = {
  "nvidia-t4": { name: "NVIDIA T4", vramGb: 16 },
  "nvidia-l4": { name: "NVIDIA L4", vramGb: 24 },
  "nvidia-a10": { name: "NVIDIA A10", vramGb: 24 },
  "nvidia-l40s": { name: "NVIDIA L40S", vramGb: 48 },
  "nvidia-a100-40gb": { name: "NVIDIA A100 40 GB", vramGb: 40 },
  "nvidia-a100-80gb": { name: "NVIDIA A100 80 GB", vramGb: 80 },
  "nvidia-rtx-pro-6000": { name: "NVIDIA RTX PRO 6000", vramGb: 96 },
  "nvidia-h100": { name: "NVIDIA H100", vramGb: 80 },
  "nvidia-h200": { name: "NVIDIA H200", vramGb: 141 },
  "nvidia-b200": { name: "NVIDIA B200", vramGb: 180 },
  "nvidia-b300": { name: "NVIDIA B300", vramGb: 288 },
};

export type GpuOffer = {
  provider: GpuJobProviderName;
  gpuType: GpuType;
  /** Provider-native GPU identifier passed to the provider API. */
  providerGpu: string;
  maxCount: number;
  maxRuntimeSeconds: number;
  gpuMicrousdPerHour: bigint;
  cpuMicrousdPerCoreHour: bigint;
  memoryMicrousdPerGibHour: bigint;
  /** Multipliers in basis points applied to every rate for region-pinned jobs. */
  regionMultiplierBps: { broad: number; narrow: number };
  rateCardVersion: string;
};

export type GpuRegion =
  | "us"
  | "us-east"
  | "us-central"
  | "us-south"
  | "us-west"
  | "eu"
  | "eu-west"
  | "eu-north"
  | "eu-south"
  | "ap"
  | "ap-northeast"
  | "ap-southeast"
  | "ap-south"
  | "ap-melbourne"
  | "jp"
  | "au"
  | "uk"
  | "ca"
  | "me"
  | "sa"
  | "af"
  | "mx";

// Modal's container regions (https://modal.com/docs/guide/region-selection).
export const GPU_REGIONS: ReadonlyArray<{
  id: GpuRegion;
  name: string;
  scope: "broad" | "narrow";
}> = [
  { id: "us", name: "United States", scope: "broad" },
  { id: "us-east", name: "US East", scope: "narrow" },
  { id: "us-central", name: "US Central", scope: "narrow" },
  { id: "us-south", name: "US South", scope: "narrow" },
  { id: "us-west", name: "US West", scope: "narrow" },
  { id: "eu", name: "European Economic Area", scope: "broad" },
  { id: "eu-west", name: "EU West", scope: "narrow" },
  { id: "eu-north", name: "EU North", scope: "narrow" },
  { id: "eu-south", name: "EU South", scope: "narrow" },
  { id: "ap", name: "Asia-Pacific", scope: "broad" },
  { id: "ap-northeast", name: "Asia-Pacific Northeast", scope: "narrow" },
  { id: "ap-southeast", name: "Asia-Pacific Southeast", scope: "narrow" },
  { id: "ap-south", name: "Asia-Pacific South", scope: "narrow" },
  { id: "ap-melbourne", name: "Melbourne", scope: "narrow" },
  { id: "jp", name: "Japan", scope: "narrow" },
  { id: "au", name: "Australia", scope: "narrow" },
  { id: "uk", name: "United Kingdom", scope: "narrow" },
  { id: "ca", name: "Canada", scope: "narrow" },
  { id: "me", name: "Middle East", scope: "narrow" },
  { id: "sa", name: "South America", scope: "narrow" },
  { id: "af", name: "Africa", scope: "narrow" },
  { id: "mx", name: "Mexico", scope: "narrow" },
];

export const BASE_PRICE_MULTIPLIER_BPS = 10_000;

/**
 * Modal applies one multiplier to every rate of a region-pinned container. A
 * job listing both broad and narrow regions pays the smaller one.
 */
export function regionPriceMultiplierBps(
  offer: Pick<GpuOffer, "regionMultiplierBps">,
  regions: readonly string[] | undefined,
): number {
  if (!regions || regions.length === 0) return BASE_PRICE_MULTIPLIER_BPS;
  const scopes = new Set(
    regions.map((region) => GPU_REGIONS.find((item) => item.id === region)?.scope ?? "narrow"),
  );
  return scopes.has("broad") ? offer.regionMultiplierBps.broad : offer.regionMultiplierBps.narrow;
}

export function applyPriceMultiplier(amountMicrousd: bigint, multiplierBps: number): bigint {
  const bps = BigInt(multiplierBps);
  return (amountMicrousd * bps + 5_000n) / 10_000n;
}

// Modal's minimum reservation per container when CPU or memory is not requested.
const DEFAULT_CPU_CORES_MILLI = 125n;
const DEFAULT_MEMORY_MIB = 128n;

/** Upper-bound hourly cost of a job at its requested size, including the region multiplier. */
export function estimateGpuJobHourlyMicrousd(
  offer: GpuOffer,
  input: { gpuCount: number; vcpu?: number; memoryMb?: number; multiplierBps: number },
): bigint {
  const coresMilli =
    input.vcpu === undefined ? DEFAULT_CPU_CORES_MILLI : BigInt(Math.ceil(input.vcpu * 500));
  const memoryMib = input.memoryMb === undefined ? DEFAULT_MEMORY_MIB : BigInt(input.memoryMb);
  const base =
    offer.gpuMicrousdPerHour * BigInt(input.gpuCount) +
    (offer.cpuMicrousdPerCoreHour * coresMilli + 999n) / 1_000n +
    (offer.memoryMicrousdPerGibHour * memoryMib + 1_023n) / 1_024n;
  return applyPriceMultiplier(base, input.multiplierBps);
}

// Published Modal rates (https://modal.com/pricing), 27 September 2026. GPU
// rates are per GPU; Sandbox CPU and memory rates apply to GPU Sandboxes.
// Modal bills automatic upgrades (A100 to A100-80GB, H100 to H200) at the
// requested type's rate, so the requested type determines the price.
export const MODAL_GPU_RATE_CARD_VERSION = "modal-2026-09-27";
const MODAL_CPU_MICROUSD_PER_CORE_HOUR = 141_912n;
const MODAL_MEMORY_MICROUSD_PER_GIB_HOUR = 24_012n;
const MODAL_MAX_RUNTIME_SECONDS = 86_400;
// https://modal.com/docs/guide/region-selection#pricing
const MODAL_REGION_MULTIPLIER_BPS = { broad: 11_500, narrow: 17_500 };

const modalGpuRates: ReadonlyArray<[GpuType, string, bigint]> = [
  ["nvidia-t4", "T4", 590_400n],
  ["nvidia-l4", "L4", 799_200n],
  ["nvidia-a10", "A10", 1_101_600n],
  ["nvidia-l40s", "L40S", 1_951_200n],
  ["nvidia-a100-40gb", "A100", 2_098_800n],
  ["nvidia-a100-80gb", "A100-80GB", 2_498_400n],
  ["nvidia-rtx-pro-6000", "RTX-PRO-6000", 3_031_200n],
  ["nvidia-h100", "H100", 3_949_200n],
  ["nvidia-h200", "H200", 4_539_600n],
  ["nvidia-b200", "B200", 6_249_600n],
  ["nvidia-b300", "B300", 7_099_200n],
];

export const GPU_OFFERS: readonly GpuOffer[] = modalGpuRates.map(
  ([gpuType, providerGpu, gpuMicrousdPerHour]) => ({
    provider: "modal",
    gpuType,
    providerGpu,
    maxCount: gpuType === "nvidia-a10" ? 4 : 8,
    maxRuntimeSeconds: MODAL_MAX_RUNTIME_SECONDS,
    gpuMicrousdPerHour,
    cpuMicrousdPerCoreHour: MODAL_CPU_MICROUSD_PER_CORE_HOUR,
    memoryMicrousdPerGibHour: MODAL_MEMORY_MICROUSD_PER_GIB_HOUR,
    regionMultiplierBps: MODAL_REGION_MULTIPLIER_BPS,
    rateCardVersion: MODAL_GPU_RATE_CARD_VERSION,
  }),
);

export function findGpuOffer(provider: GpuJobProviderName, gpuType: GpuType): GpuOffer | undefined {
  return GPU_OFFERS.find((offer) => offer.provider === provider && offer.gpuType === gpuType);
}

export type ProviderGpuJobSubmitInput = {
  metalGpuJobId: string;
  organizationId: string;
  projectId: string;
  image: string;
  command: readonly string[];
  workingDir?: string;
  gpu: { type: GpuType; count: number };
  resources: { vcpu?: number; memoryMb?: number };
  regions?: readonly GpuRegion[];
  maxRuntimeSeconds: number;
  /**
   * Hard stop the provider enforces from submission. Covers the remaining start
   * window plus the runtime, since Metal measures runtime from container start.
   */
  providerTimeoutSeconds: number;
  environment: Readonly<Record<string, string>>;
  secrets: Readonly<Record<string, string>>;
  registryAuth?: ProviderGpuJobRegistryAuth;
  bucketMounts?: readonly ProviderGpuJobBucketMount[];
  providerOptions: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
};

export type ProviderGpuJobRegistryAuth =
  | { kind: "basic"; username: string; password: string }
  | { kind: "aws_ecr"; accessKeyId: string; secretAccessKey: string; region: string }
  | { kind: "gcp_artifact_registry"; serviceAccountJson: string };

export type ProviderGpuJobBucketMount = {
  provider: "s3" | "r2" | "gcs";
  bucket: string;
  mountPath: string;
  keyPrefix?: string;
  endpointUrl?: string;
  region?: string;
  readOnly: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
};

export type ProviderGpuJobResolved = {
  gpuType: GpuType;
  gpuCount: number;
  providerGpu: string;
  vcpu: number | null;
  memoryMb: number | null;
};

export type ProviderGpuJob = {
  providerResourceId: string;
  providerOrganizationId: string;
  providerMetadata?: Record<string, unknown>;
  resolved: ProviderGpuJobResolved;
};

export type ProviderGpuJobStatus =
  /** Accepted by the provider but no container has started, usually while waiting for GPUs. */
  | { state: "pending" }
  | { state: "running" }
  | { state: "succeeded"; exitCode: number }
  | {
      state: "failed";
      exitCode: number | null;
      reason:
        | "exit_code_nonzero"
        | "provider_init_failed"
        | "provider_internal_failure"
        | "provider_idle_timeout";
      message: string | null;
    }
  | { state: "timed_out"; exitCode: number | null }
  | { state: "terminated"; exitCode: number | null }
  | { state: "absent" };

export type ProviderGpuJobLogStream = "stdout" | "stderr";

export type ProviderGpuJobLogReadInput = {
  providerResourceId: string;
  cursors: Partial<Record<ProviderGpuJobLogStream, string>>;
  complete: Partial<Record<ProviderGpuJobLogStream, boolean>>;
  waitMs: number;
  maxBytes: number;
  signal?: AbortSignal;
};

export type ProviderGpuJobLogChunk = {
  stream: ProviderGpuJobLogStream;
  data: Uint8Array;
};

export type ProviderGpuJobLogReadResult = {
  chunks: ProviderGpuJobLogChunk[];
  cursors: Partial<Record<ProviderGpuJobLogStream, string>>;
  complete: Record<ProviderGpuJobLogStream, boolean>;
};

export type ProviderGpuJobCostInput = {
  providerResourceId: string;
  providerOrganizationId?: string;
  providerMetadata?: Record<string, unknown>;
  gpu: { type: GpuType; count: number };
  priceMultiplierBps: number;
  from: Date;
  to: Date;
  signal?: AbortSignal;
};

export type ProviderGpuJobListing = {
  providerResourceId: string;
  /** The Metal job ID the provider resource was tagged with, if any. */
  metalGpuJobId: string | null;
  /** The Metal deployment that created the resource, so sweeps never touch another's. */
  metalEnvironment: string | null;
  createdAt: Date;
};

export type ProviderGpuJobTaskWindow = {
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type ProviderReportedCost = {
  amountMicrousd: bigint;
  /** Provider-side scope the amount covers, such as an app ID. */
  scope: string;
  raw: Record<string, unknown>;
};

export type GpuJobProviderCapabilities = {
  cost: boolean;
  logs: boolean;
  secrets: boolean;
  volumes: boolean;
};

export interface GpuJobProvider {
  readonly name: GpuJobProviderName;
  readonly capabilities: GpuJobProviderCapabilities;
  /** Starts the job. Must be safe to call again with the same Metal job ID. */
  submit(input: ProviderGpuJobSubmitInput): Promise<ProviderGpuJob>;
  /** Finds a job created for this Metal job ID after an uncertain submit. */
  reconcileSubmit(
    input: Pick<ProviderGpuJobSubmitInput, "metalGpuJobId" | "gpu" | "resources" | "signal">,
  ): Promise<ProviderGpuJob | null>;
  status(providerResourceId: string, signal?: AbortSignal): Promise<ProviderGpuJobStatus>;
  readLogs(input: ProviderGpuJobLogReadInput): Promise<ProviderGpuJobLogReadResult>;
  /** Terminates the job. Succeeds when the job is already gone. */
  cancel(providerResourceId: string, signal?: AbortSignal): Promise<void>;
  getCost(input: ProviderGpuJobCostInput): Promise<ProviderSandboxCost | null>;
  /**
   * When the provider's container started and stopped. Settlement never bills
   * less than this window, and it supplies the start of jobs that finished
   * before the monitor saw them running.
   */
  taskWindow?(input: {
    providerResourceId: string;
    metalGpuJobId: string;
    signal?: AbortSignal;
  }): Promise<ProviderGpuJobTaskWindow | null>;
  /** Lists provider resources that are still running, so leaked ones can be terminated. */
  listActiveJobs?(signal?: AbortSignal): Promise<ProviderGpuJobListing[]>;
  /** The provider's own billed amount for Metal's jobs in a closed time window. */
  reportedCost?(input: {
    from: Date;
    to: Date;
    signal?: AbortSignal;
  }): Promise<ProviderReportedCost>;
}
