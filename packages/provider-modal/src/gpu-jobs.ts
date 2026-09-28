import {
  AlreadyExistsError,
  InvalidError,
  ModalClient,
  NotFoundError,
  type CloudBucketMount,
  type Image,
  type Sandbox,
  type Secret,
} from "modal";
import {
  BASE_PRICE_MULTIPLIER_BPS,
  ProviderError,
  applyPriceMultiplier,
  findGpuOffer,
  type GpuJobProvider,
  type ProviderGpuJob,
  type ProviderGpuJobBucketMount,
  type ProviderGpuJobCostInput,
  type ProviderGpuJobListing,
  type ProviderGpuJobLogChunk,
  type ProviderGpuJobLogReadInput,
  type ProviderGpuJobLogReadResult,
  type ProviderGpuJobLogStream,
  type ProviderGpuJobRegistryAuth,
  type ProviderGpuJobStatus,
  type ProviderGpuJobSubmitInput,
  type ProviderReportedCost,
  type ProviderSandboxCost,
} from "@openmetal/provider-core";
import { parseResourceUsage, usageFromMetadata, type ModalResourceUsage } from "./modal-usage.js";

// Values of Modal's GenericResult.status, which the JS SDK does not export.
const MODAL_STATUS = {
  unspecified: 0,
  success: 1,
  failure: 2,
  terminated: 3,
  timeout: 4,
  initFailure: 5,
  internalFailure: 6,
  idleTimeout: 7,
} as const;
const FILE_DESCRIPTORS: Record<ProviderGpuJobLogStream, number> = { stdout: 1, stderr: 2 };
const NANOSECONDS_PER_HOUR = 3_600_000_000_000n;
const GRPC_NOT_FOUND = 5;
const DEFAULT_APP_NAME = "metal-gpu-jobs";
const JOB_TAG = "metal.gpu_job_id";
const ENVIRONMENT_TAG = "metal.environment";
const MODAL_MAX_TIMEOUT_SECONDS = 86_400;
const GCS_ENDPOINT_URL = "https://storage.googleapis.com";

/** Parses Modal's decimal USD strings, rounding half up to whole micro-USD. */
export function modalUsdToMicrousd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new ProviderError("Modal returned an invalid cost amount", "unavailable", true);
  const tenMillionths = BigInt((match[2] ?? "").padEnd(7, "0").slice(0, 7));
  return BigInt(match[1]!) * 1_000_000n + (tenMillionths + 5n) / 10n;
}

function registryImage(
  client: ModalClient,
  image: string,
  auth: ProviderGpuJobRegistryAuth | undefined,
  secret: Secret | undefined,
): Image {
  if (!auth || !secret) return client.images.fromRegistry(image);
  switch (auth.kind) {
    case "basic":
      return client.images.fromRegistry(image, secret);
    case "aws_ecr":
      return client.images.fromAwsEcr(image, secret);
    case "gcp_artifact_registry":
      return client.images.fromGcpArtifactRegistry(image, secret);
  }
}

function registrySecretValues(auth: ProviderGpuJobRegistryAuth): Record<string, string> {
  switch (auth.kind) {
    case "basic":
      return { REGISTRY_USERNAME: auth.username, REGISTRY_PASSWORD: auth.password };
    case "aws_ecr":
      return {
        AWS_ACCESS_KEY_ID: auth.accessKeyId,
        AWS_SECRET_ACCESS_KEY: auth.secretAccessKey,
        AWS_REGION: auth.region,
      };
    case "gcp_artifact_registry":
      return { SERVICE_ACCOUNT_JSON: auth.serviceAccountJson };
  }
}

function bucketSecretValues(mount: ProviderGpuJobBucketMount): Record<string, string> {
  if (mount.provider === "gcs") {
    return {
      GOOGLE_ACCESS_KEY_ID: mount.credentials.accessKeyId,
      GOOGLE_ACCESS_KEY_SECRET: mount.credentials.secretAccessKey,
    };
  }
  return {
    AWS_ACCESS_KEY_ID: mount.credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: mount.credentials.secretAccessKey,
    ...(mount.credentials.sessionToken
      ? { AWS_SESSION_TOKEN: mount.credentials.sessionToken }
      : {}),
    ...(mount.region ? { AWS_REGION: mount.region } : {}),
  };
}

type VolumeMount = { name: string; mount_path: string };

function isNotFound(error: unknown): boolean {
  return (
    error instanceof NotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === GRPC_NOT_FOUND)
  );
}

async function withDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("Modal operation aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new Error("Modal operation aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => reject(new ProviderError("Modal operation deadline exceeded", "unknown_outcome", true)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function volumeMounts(providerOptions: Readonly<Record<string, unknown>>): VolumeMount[] {
  const volumes = providerOptions.volumes;
  if (volumes === undefined) return [];
  if (
    !Array.isArray(volumes) ||
    !volumes.every(
      (volume): volume is VolumeMount =>
        typeof volume === "object" &&
        volume !== null &&
        typeof (volume as VolumeMount).name === "string" &&
        typeof (volume as VolumeMount).mount_path === "string",
    )
  ) {
    throw new ProviderError("Modal volume options are invalid", "invalid_request", false);
  }
  return volumes;
}

export type ModalGpuJobProviderOptions = {
  tokenId: string;
  tokenSecret: string;
  appName?: string;
  environment?: string;
  requestTimeoutMs?: number;
  /**
   * Volumes persist in the Modal workspace that owns the credentials, so they
   * are only allowed when a customer brings their own Modal workspace.
   */
  allowVolumes?: boolean;
  /** Tags every Sandbox with the Metal deployment that created it. */
  metalEnvironment?: string;
  client?: ModalClient;
};

export class ModalGpuJobProvider implements GpuJobProvider {
  readonly name = "modal" as const;
  readonly capabilities: GpuJobProvider["capabilities"];
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly environment?: string;
  private readonly requestTimeoutMs: number;
  private readonly allowVolumes: boolean;
  private readonly metalEnvironment?: string;
  private readonly startedSandboxes = new Set<string>();

  constructor(options: ModalGpuJobProviderOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.client =
      options.client ??
      new ModalClient({
        tokenId: options.tokenId,
        tokenSecret: options.tokenSecret,
        environment: options.environment,
        timeoutMs: this.requestTimeoutMs,
      });
    this.appName = options.appName ?? DEFAULT_APP_NAME;
    this.environment = options.environment;
    this.allowVolumes = options.allowVolumes ?? false;
    this.metalEnvironment = options.metalEnvironment;
    this.capabilities = { cost: true, logs: true, secrets: true, volumes: this.allowVolumes };
  }

  async submit(input: ProviderGpuJobSubmitInput): Promise<ProviderGpuJob> {
    const offer = findGpuOffer("modal", input.gpu.type);
    if (!offer) {
      throw new ProviderError(`Modal does not offer ${input.gpu.type}`, "unsupported", false);
    }
    if (input.gpu.count > offer.maxCount) {
      throw new ProviderError(
        `Modal supports at most ${offer.maxCount} ${input.gpu.type} GPUs per job`,
        "unsupported",
        false,
      );
    }
    if (input.maxRuntimeSeconds > offer.maxRuntimeSeconds) {
      throw new ProviderError(
        `Modal jobs run for at most ${offer.maxRuntimeSeconds} seconds`,
        "unsupported",
        false,
      );
    }
    const mounts = volumeMounts(input.providerOptions);
    if (mounts.length > 0 && !this.allowVolumes) {
      throw new ProviderError(
        "Modal volumes require your own Modal credentials",
        "unsupported",
        false,
      );
    }
    const app = await withDeadline(
      this.client.apps.fromName(this.appName, {
        createIfMissing: true,
        environment: this.environment,
      }),
      input.signal,
      this.requestTimeoutMs,
    );
    const ephemeralSecret = (values: Record<string, string>) =>
      withDeadline(
        this.client.secrets.fromObject(values, { environment: this.environment }),
        input.signal,
        this.requestTimeoutMs,
      );
    const image = registryImage(
      this.client,
      input.image,
      input.registryAuth,
      input.registryAuth
        ? await ephemeralSecret(registrySecretValues(input.registryAuth))
        : undefined,
    );
    const secrets =
      Object.keys(input.secrets).length > 0 ? [await ephemeralSecret({ ...input.secrets })] : [];
    const cloudBucketMounts: Record<string, CloudBucketMount> = {};
    for (const mount of input.bucketMounts ?? []) {
      cloudBucketMounts[mount.mountPath] = this.client.cloudBucketMounts.create(mount.bucket, {
        secret: await ephemeralSecret(bucketSecretValues(mount)),
        readOnly: mount.readOnly,
        ...(mount.keyPrefix ? { keyPrefix: mount.keyPrefix } : {}),
        ...(mount.provider === "gcs"
          ? { bucketEndpointUrl: mount.endpointUrl ?? GCS_ENDPOINT_URL }
          : mount.endpointUrl
            ? { bucketEndpointUrl: mount.endpointUrl }
            : {}),
      });
    }
    const volumes = Object.fromEntries(
      await Promise.all(
        mounts.map(async (mount) => [
          mount.mount_path,
          await withDeadline(
            this.client.volumes.fromName(mount.name, {
              createIfMissing: true,
              environment: this.environment,
            }),
            input.signal,
            this.requestTimeoutMs,
          ),
        ]),
      ),
    );
    const providerGpu =
      input.gpu.count > 1 ? `${offer.providerGpu}:${input.gpu.count}` : offer.providerGpu;
    const name = this.sandboxName(input.metalGpuJobId);
    let sandbox: Sandbox;
    try {
      sandbox = await withDeadline(
        this.client.sandboxes.create(app, image, {
          name,
          gpu: providerGpu,
          command: [...input.command],
          ...(input.workingDir ? { workdir: input.workingDir } : {}),
          env: { ...input.environment },
          secrets,
          volumes,
          ...(Object.keys(cloudBucketMounts).length > 0 ? { cloudBucketMounts } : {}),
          ...(input.regions && input.regions.length > 0 ? { regions: [...input.regions] } : {}),
          timeoutMs:
            Math.min(MODAL_MAX_TIMEOUT_SECONDS, Math.max(input.providerTimeoutSeconds, 1)) * 1_000,
          ...(input.resources.vcpu === undefined ? {} : { cpu: input.resources.vcpu / 2 }),
          ...(input.resources.memoryMb === undefined
            ? {}
            : { memoryMiB: input.resources.memoryMb }),
          tags: {
            [JOB_TAG]: input.metalGpuJobId,
            "metal.organization_id": input.organizationId,
            "metal.project_id": input.projectId,
            ...(this.metalEnvironment ? { [ENVIRONMENT_TAG]: this.metalEnvironment } : {}),
          },
        }),
        input.signal,
        this.requestTimeoutMs * 2,
      );
    } catch (error) {
      if (error instanceof AlreadyExistsError) {
        sandbox = await withDeadline(
          this.client.sandboxes.fromName(this.appName, name, { environment: this.environment }),
          input.signal,
          this.requestTimeoutMs,
        );
      } else if (error instanceof InvalidError) {
        throw new ProviderError(
          `Modal rejected the job: ${error.message}`,
          "invalid_request",
          false,
        );
      } else {
        throw error;
      }
    }
    return this.toProviderJob(sandbox.sandboxId, app.appId, providerGpu, input);
  }

  async reconcileSubmit(
    input: Pick<ProviderGpuJobSubmitInput, "metalGpuJobId" | "gpu" | "resources" | "signal">,
  ): Promise<ProviderGpuJob | null> {
    const offer = findGpuOffer("modal", input.gpu.type);
    if (!offer) return null;
    let appId: string;
    try {
      const app = await withDeadline(
        this.client.apps.fromName(this.appName, { environment: this.environment }),
        input.signal,
        this.requestTimeoutMs,
      );
      appId = app.appId;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const providerGpu =
      input.gpu.count > 1 ? `${offer.providerGpu}:${input.gpu.count}` : offer.providerGpu;
    const listed = this.client.sandboxes.list({
      appId,
      tags: { [JOB_TAG]: input.metalGpuJobId },
      environment: this.environment,
    });
    for await (const sandbox of listed) {
      return this.toProviderJob(sandbox.sandboxId, appId, providerGpu, input);
    }
    return null;
  }

  async status(providerResourceId: string, signal?: AbortSignal): Promise<ProviderGpuJobStatus> {
    let response: Awaited<ReturnType<ModalClient["cpClient"]["sandboxWait"]>>;
    try {
      response = await withDeadline(
        this.client.cpClient.sandboxWait({ sandboxId: providerResourceId, timeout: 0 }),
        signal,
        this.requestTimeoutMs,
      );
    } catch (error) {
      if (isNotFound(error)) return { state: "absent" };
      throw error;
    }
    const result = response.result;
    if (!result || result.status === MODAL_STATUS.unspecified) {
      return (await this.hasStarted(providerResourceId, signal))
        ? { state: "running" }
        : { state: "pending" };
    }
    this.startedSandboxes.delete(providerResourceId);
    const exitCode = Number.isInteger(result.exitcode) ? result.exitcode : null;
    const message = result.exception ? result.exception.slice(0, 500) : null;
    switch (result.status) {
      case MODAL_STATUS.success:
        return { state: "succeeded", exitCode: exitCode ?? 0 };
      case MODAL_STATUS.failure:
        return { state: "failed", exitCode, reason: "exit_code_nonzero", message };
      case MODAL_STATUS.terminated:
        return { state: "terminated", exitCode };
      case MODAL_STATUS.timeout:
        return { state: "timed_out", exitCode };
      case MODAL_STATUS.initFailure:
        return { state: "failed", exitCode, reason: "provider_init_failed", message };
      case MODAL_STATUS.idleTimeout:
        return { state: "failed", exitCode, reason: "provider_idle_timeout", message };
      default:
        return { state: "failed", exitCode, reason: "provider_internal_failure", message };
    }
  }

  /** Modal assigns a task once a container is placed on a GPU worker. */
  private async hasStarted(providerResourceId: string, signal?: AbortSignal): Promise<boolean> {
    if (this.startedSandboxes.has(providerResourceId)) return true;
    const response = await withDeadline(
      this.client.cpClient.sandboxGetTaskId({
        sandboxId: providerResourceId,
        timeout: 0,
        waitUntilReady: false,
      }),
      signal,
      this.requestTimeoutMs,
    );
    if (!response.taskId) return false;
    this.startedSandboxes.add(providerResourceId);
    return true;
  }

  async readLogs(input: ProviderGpuJobLogReadInput): Promise<ProviderGpuJobLogReadResult> {
    const encoder = new TextEncoder();
    const deadline = Date.now() + input.waitMs;
    const cursors = { ...input.cursors };
    const complete: Record<ProviderGpuJobLogStream, boolean> = {
      stdout: input.complete.stdout === true,
      stderr: input.complete.stderr === true,
    };
    const collected: Array<ProviderGpuJobLogChunk & { timestamp: number; order: number }> = [];
    let bytes = 0;
    let order = 0;
    const streams = (["stdout", "stderr"] as const).filter((stream) => !complete[stream]);
    await Promise.all(
      streams.map(async (stream) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
        try {
          const batches = this.client.cpClient.sandboxGetLogs(
            {
              sandboxId: input.providerResourceId,
              fileDescriptor: FILE_DESCRIPTORS[stream],
              timeout: Math.max(1, Math.ceil(input.waitMs / 1_000)),
              lastEntryId: cursors[stream] ?? "0-0",
            },
            { signal: controller.signal },
          );
          for await (const batch of batches) {
            for (const item of batch.items) {
              const data = encoder.encode(item.data);
              if (data.byteLength === 0) continue;
              collected.push({ stream, data, timestamp: item.timestamp, order: order++ });
              bytes += data.byteLength;
            }
            if (batch.entryId) cursors[stream] = batch.entryId;
            if (batch.eof) {
              complete[stream] = true;
              break;
            }
            if (bytes >= input.maxBytes) break;
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (isNotFound(error)) {
            complete[stream] = true;
            return;
          }
          throw error;
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          controller.abort();
        }
      }),
    );
    collected.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
    return {
      chunks: collected.map(({ stream, data }) => ({ stream, data })),
      cursors,
      complete,
    };
  }

  async cancel(providerResourceId: string, signal?: AbortSignal): Promise<void> {
    try {
      const sandbox = await withDeadline(
        this.client.sandboxes.fromId(providerResourceId),
        signal,
        this.requestTimeoutMs,
      );
      await withDeadline(sandbox.terminate(), signal, this.requestTimeoutMs);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async startedAt(input: {
    providerResourceId: string;
    metalGpuJobId: string;
    signal?: AbortSignal;
  }): Promise<Date | null> {
    const app = await withDeadline(
      this.client.apps.fromName(this.appName, { environment: this.environment }),
      input.signal,
      this.requestTimeoutMs,
    );
    const response = await withDeadline(
      this.client.cpClient.sandboxList({
        appId: app.appId,
        beforeTimestamp: 0,
        environmentName: this.environment ?? "",
        includeFinished: true,
        tags: [{ tagName: JOB_TAG, tagValue: input.metalGpuJobId }],
      }),
      input.signal,
      this.requestTimeoutMs,
    );
    const startedAt = response.sandboxes.find((info) => info.id === input.providerResourceId)
      ?.taskInfo?.startedAt;
    return startedAt ? new Date(startedAt * 1_000) : null;
  }

  async listActiveJobs(signal?: AbortSignal): Promise<ProviderGpuJobListing[]> {
    let appId: string;
    try {
      appId = (
        await withDeadline(
          this.client.apps.fromName(this.appName, { environment: this.environment }),
          signal,
          this.requestTimeoutMs,
        )
      ).appId;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const listings: ProviderGpuJobListing[] = [];
    let beforeTimestamp: number | undefined;
    for (;;) {
      const response = await withDeadline(
        this.client.cpClient.sandboxList({
          appId,
          beforeTimestamp: beforeTimestamp ?? 0,
          environmentName: this.environment ?? "",
          includeFinished: false,
          tags: [],
        }),
        signal,
        this.requestTimeoutMs,
      );
      if (response.sandboxes.length === 0) return listings;
      for (const info of response.sandboxes) {
        listings.push({
          providerResourceId: info.id,
          metalGpuJobId: info.tags.find((tag) => tag.tagName === JOB_TAG)?.tagValue ?? null,
          metalEnvironment:
            info.tags.find((tag) => tag.tagName === ENVIRONMENT_TAG)?.tagValue ?? null,
          createdAt: new Date(info.createdAt * 1_000),
        });
      }
      const next = response.sandboxes.at(-1)!.createdAt;
      if (beforeTimestamp !== undefined && next >= beforeTimestamp) return listings;
      beforeTimestamp = next;
    }
  }

  /**
   * Modal's billing report itemizes cost per app and hour, including region
   * multipliers, so it covers every managed job in this provider's app.
   */
  async reportedCost(input: {
    from: Date;
    to: Date;
    signal?: AbortSignal;
  }): Promise<ProviderReportedCost> {
    const app = await withDeadline(
      this.client.apps.fromName(this.appName, { environment: this.environment }),
      input.signal,
      this.requestTimeoutMs,
    );
    const items = this.client.cpClient.workspaceBillingReport(
      {
        startTimestamp: input.from,
        endTimestamp: input.to,
        resolution: "h",
        tagNames: [],
        environmentIds: [],
        appIds: [app.appId],
      },
      { signal: input.signal },
    );
    let amountMicrousd = 0n;
    const byResource: Record<string, bigint> = {};
    let intervals = 0;
    for await (const item of items) {
      const interval = item.interval?.getTime();
      if (item.objectId !== app.appId || interval === undefined) continue;
      if (interval < input.from.getTime() || interval >= input.to.getTime()) continue;
      intervals += 1;
      amountMicrousd += modalUsdToMicrousd(item.cost);
      for (const [resource, cost] of Object.entries(item.costByResource)) {
        byResource[resource] = (byResource[resource] ?? 0n) + modalUsdToMicrousd(cost);
      }
    }
    return {
      amountMicrousd,
      scope: app.appId,
      raw: {
        appName: this.appName,
        intervals,
        costByResourceMicrousd: Object.fromEntries(
          Object.entries(byResource).map(([resource, cost]) => [resource, cost.toString()]),
        ),
      },
    };
  }

  async getCost(input: ProviderGpuJobCostInput): Promise<ProviderSandboxCost | null> {
    const offer = findGpuOffer("modal", input.gpu.type);
    if (!offer) {
      throw new ProviderError(`Modal does not offer ${input.gpu.type}`, "unsupported", false);
    }
    const usage =
      usageFromMetadata(input.providerMetadata) ??
      (await this.resourceUsage(input.providerResourceId, input.signal));
    const numerator =
      BigInt(usage.gpuNanosecs) * offer.gpuMicrousdPerHour +
      BigInt(usage.cpuCoreNanosecs) * offer.cpuMicrousdPerCoreHour +
      BigInt(usage.memGibNanosecs) * offer.memoryMicrousdPerGibHour;
    const baseMicrousd = (numerator + NANOSECONDS_PER_HOUR / 2n) / NANOSECONDS_PER_HOUR;
    const multiplierBps = input.priceMultiplierBps ?? BASE_PRICE_MULTIPLIER_BPS;
    return {
      amountMicrousd: applyPriceMultiplier(baseMicrousd, multiplierBps),
      providerOrganizationId: input.providerOrganizationId ?? this.appName,
      measuredThrough: input.to,
      provenance: "provider_metered",
      confidence: "medium",
      source: "modal-gpu-sandbox-resource-usage-published-rate-card",
      rateCardVersion: offer.rateCardVersion,
      raw: {
        cumulative: true,
        excludes: ["credits", "discounts"],
        rateCardVersion: offer.rateCardVersion,
        billedGpuType: input.gpu.type,
        baseMicrousd: baseMicrousd.toString(),
        priceMultiplierBps: multiplierBps,
        usage: {
          cpuCoreNanosecs: usage.cpuCoreNanosecs.toString(),
          memGibNanosecs: usage.memGibNanosecs.toString(),
          gpuNanosecs: usage.gpuNanosecs.toString(),
          gpuType: usage.gpuType ?? null,
        },
        ratesMicrousdPerHour: {
          gpu: offer.gpuMicrousdPerHour.toString(),
          cpuCore: offer.cpuMicrousdPerCoreHour.toString(),
          memoryGib: offer.memoryMicrousdPerGibHour.toString(),
        },
      },
    };
  }

  private sandboxName(metalGpuJobId: string): string {
    return `metal-${metalGpuJobId}`;
  }

  private toProviderJob(
    sandboxId: string,
    appId: string,
    providerGpu: string,
    input: Pick<ProviderGpuJobSubmitInput, "gpu" | "resources">,
  ): ProviderGpuJob {
    return {
      providerResourceId: sandboxId,
      providerOrganizationId: appId,
      providerMetadata: { modal: { appName: this.appName, providerGpu } },
      resolved: {
        gpuType: input.gpu.type,
        gpuCount: input.gpu.count,
        providerGpu,
        vcpu: input.resources.vcpu ?? null,
        memoryMb: input.resources.memoryMb ?? null,
      },
    };
  }

  private async resourceUsage(
    providerResourceId: string,
    signal: AbortSignal | undefined,
  ): Promise<ModalResourceUsage> {
    const usage = await withDeadline(
      this.client.cpClient.sandboxGetResourceUsage({ sandboxId: providerResourceId }),
      signal,
      this.requestTimeoutMs,
    );
    const parsed = parseResourceUsage(usage);
    if (!parsed) {
      throw new ProviderError("Modal returned invalid sandbox resource usage", "unavailable", true);
    }
    return parsed;
  }
}
