import { AlreadyExistsError, NotFoundError } from "modal";
import { describe, expect, it, vi } from "vitest";
import { ModalGpuJobProvider, modalUsdToMicrousd } from "../src/gpu-jobs.js";
import { parseResourceUsage } from "../src/modal-usage.js";

type Batch = {
  entryId: string;
  eof: boolean;
  items: Array<{ data: string; timestamp: number }>;
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  const app = { appId: "ap-1" };
  const image = { imageId: "im-1" };
  const secret = { secretId: "st-1" };
  const volume = { volumeId: "vo-1" };
  const sandbox = { sandboxId: "sb-1", terminate: vi.fn().mockResolvedValue(undefined) };
  const client = {
    apps: { fromName: vi.fn().mockResolvedValue(app) },
    images: {
      fromRegistry: vi.fn().mockReturnValue(image),
      fromAwsEcr: vi.fn().mockReturnValue(image),
      fromGcpArtifactRegistry: vi.fn().mockReturnValue(image),
    },
    cloudBucketMounts: {
      create: vi.fn((bucket: string, params: Record<string, unknown>) => ({ bucket, ...params })),
    },
    secrets: { fromObject: vi.fn().mockResolvedValue(secret) },
    volumes: { fromName: vi.fn().mockResolvedValue(volume) },
    sandboxes: {
      create: vi.fn().mockResolvedValue(sandbox),
      fromName: vi.fn().mockResolvedValue(sandbox),
      fromId: vi.fn().mockResolvedValue(sandbox),
      list: vi.fn(),
    },
    cpClient: {
      sandboxWait: vi.fn(),
      sandboxGetTaskId: vi.fn().mockResolvedValue({ taskId: "ta-1" }),
      sandboxGetLogs: vi.fn(),
      sandboxGetResourceUsage: vi.fn(),
      sandboxList: vi.fn(),
      workspaceBillingReport: vi.fn(),
    },
    ...overrides,
  };
  return { client, app, image, secret, volume, sandbox };
}

function submitInput(overrides: Record<string, unknown> = {}) {
  return {
    metalGpuJobId: "gpj_1",
    organizationId: "org-1",
    projectId: "project-1",
    image: "pytorch/pytorch:latest",
    command: ["python", "train.py"],
    gpu: { type: "nvidia-h100" as const, count: 2 },
    resources: { vcpu: 8, memoryMb: 32_768 },
    maxRuntimeSeconds: 3_600,
    providerTimeoutSeconds: 3_720,
    environment: { EPOCHS: "3" },
    secrets: { HF_TOKEN: "hf_secret" },
    providerOptions: {},
    ...overrides,
  };
}

async function* batches(items: Batch[]) {
  for (const item of items) yield item;
}

describe("ModalGpuJobProvider", () => {
  it("maps a portable GPU job onto a Modal GPU Sandbox", async () => {
    const { client, app, image, secret } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    const job = await provider.submit(submitInput({ workingDir: "/workspace" }));

    expect(client.apps.fromName).toHaveBeenCalledWith("metal-gpu-jobs", {
      createIfMissing: true,
      environment: undefined,
    });
    expect(client.images.fromRegistry).toHaveBeenCalledWith("pytorch/pytorch:latest");
    expect(client.secrets.fromObject).toHaveBeenCalledWith(
      { HF_TOKEN: "hf_secret" },
      { environment: undefined },
    );
    expect(client.sandboxes.create).toHaveBeenCalledWith(app, image, {
      name: "metal-gpj_1",
      gpu: "H100:2",
      command: ["python", "train.py"],
      workdir: "/workspace",
      env: { EPOCHS: "3" },
      secrets: [secret],
      volumes: {},
      timeoutMs: 3_720_000,
      cpu: 4,
      memoryMiB: 32_768,
      tags: {
        "metal.gpu_job_id": "gpj_1",
        "metal.organization_id": "org-1",
        "metal.project_id": "project-1",
      },
    });
    expect(job).toEqual({
      providerResourceId: "sb-1",
      providerOrganizationId: "ap-1",
      providerMetadata: { modal: { appName: "metal-gpu-jobs", providerGpu: "H100:2" } },
      resolved: {
        gpuType: "nvidia-h100",
        gpuCount: 2,
        providerGpu: "H100:2",
        vcpu: 8,
        memoryMb: 32_768,
      },
    });
  });

  it("omits optional Modal parameters that were not requested", async () => {
    const { client } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    await provider.submit(
      submitInput({
        gpu: { type: "nvidia-t4", count: 1 },
        resources: {},
        secrets: {},
        environment: {},
      }),
    );

    expect(client.secrets.fromObject).not.toHaveBeenCalled();
    const params = client.sandboxes.create.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params.gpu).toBe("T4");
    expect(params.secrets).toEqual([]);
    expect(params).not.toHaveProperty("cpu");
    expect(params).not.toHaveProperty("memoryMiB");
    expect(params).not.toHaveProperty("workdir");
  });

  it("rejects volumes on managed credentials and mounts them with BYOK", async () => {
    const managed = fakeClient();
    const managedProvider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: managed.client as never,
    });
    const options = { volumes: [{ name: "checkpoints", mount_path: "/checkpoints" }] };

    await expect(
      managedProvider.submit(submitInput({ providerOptions: options })),
    ).rejects.toMatchObject({ kind: "unsupported", retryable: false });
    expect(managed.client.sandboxes.create).not.toHaveBeenCalled();

    const byok = fakeClient();
    const byokProvider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      allowVolumes: true,
      client: byok.client as never,
    });
    await byokProvider.submit(submitInput({ providerOptions: options }));
    expect(byok.client.volumes.fromName).toHaveBeenCalledWith("checkpoints", {
      createIfMissing: true,
      environment: undefined,
    });
    expect(byok.client.sandboxes.create.mock.calls[0]?.[2]).toMatchObject({
      volumes: { "/checkpoints": byok.volume },
    });
  });

  it("rejects GPU counts and runtimes beyond the Modal offer before calling Modal", async () => {
    const { client } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    await expect(
      provider.submit(submitInput({ gpu: { type: "nvidia-a10", count: 8 } })),
    ).rejects.toMatchObject({ kind: "unsupported" });
    await expect(provider.submit(submitInput({ maxRuntimeSeconds: 90_000 }))).rejects.toMatchObject(
      { kind: "unsupported" },
    );
    expect(client.apps.fromName).not.toHaveBeenCalled();
  });

  it("adopts the running Sandbox when a retried submit collides on its name", async () => {
    const { client, sandbox } = fakeClient();
    client.sandboxes.create.mockRejectedValueOnce(new AlreadyExistsError("exists"));
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    const job = await provider.submit(submitInput());

    expect(client.sandboxes.fromName).toHaveBeenCalledWith("metal-gpu-jobs", "metal-gpj_1", {
      environment: undefined,
    });
    expect(job.providerResourceId).toBe(sandbox.sandboxId);
  });

  it("reconciles an uncertain submit by the Metal job tag", async () => {
    const { client } = fakeClient();
    client.sandboxes.list.mockReturnValue(
      (async function* () {
        yield { sandboxId: "sb-found" };
      })(),
    );
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    const found = await provider.reconcileSubmit({
      metalGpuJobId: "gpj_1",
      gpu: { type: "nvidia-l4", count: 1 },
      resources: {},
    });

    expect(client.sandboxes.list).toHaveBeenCalledWith({
      appId: "ap-1",
      tags: { "metal.gpu_job_id": "gpj_1" },
      environment: undefined,
    });
    expect(found?.providerResourceId).toBe("sb-found");

    client.sandboxes.list.mockReturnValue((async function* () {})());
    await expect(
      provider.reconcileSubmit({
        metalGpuJobId: "gpj_2",
        gpu: { type: "nvidia-l4", count: 1 },
        resources: {},
      }),
    ).resolves.toBeNull();
  });

  it("maps every Modal completion status", async () => {
    const { client } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    const cases: Array<[unknown, unknown]> = [
      [{}, { state: "running" }],
      [{ result: { status: 0 } }, { state: "running" }],
      [{ result: { status: 1, exitcode: 0 } }, { state: "succeeded", exitCode: 0 }],
      [
        { result: { status: 2, exitcode: 3, exception: "" } },
        { state: "failed", exitCode: 3, reason: "exit_code_nonzero", message: null },
      ],
      [{ result: { status: 3, exitcode: 0 } }, { state: "terminated", exitCode: 0 }],
      [{ result: { status: 4, exitcode: 0 } }, { state: "timed_out", exitCode: 0 }],
      [
        { result: { status: 5, exitcode: 0, exception: "image pull failed" } },
        {
          state: "failed",
          exitCode: 0,
          reason: "provider_init_failed",
          message: "image pull failed",
        },
      ],
      [
        { result: { status: 6, exitcode: 0, exception: "" } },
        { state: "failed", exitCode: 0, reason: "provider_internal_failure", message: null },
      ],
    ];
    for (const [response, expected] of cases) {
      client.cpClient.sandboxWait.mockResolvedValueOnce(response);
      await expect(provider.status("sb-1")).resolves.toEqual(expected);
    }
    client.cpClient.sandboxWait.mockRejectedValueOnce(new NotFoundError("gone"));
    await expect(provider.status("sb-1")).resolves.toEqual({ state: "absent" });
    expect(client.cpClient.sandboxWait).toHaveBeenCalledWith({ sandboxId: "sb-1", timeout: 0 });
  });

  it("reports a Sandbox as pending until Modal places its container", async () => {
    const { client } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    client.cpClient.sandboxWait.mockResolvedValue({});
    client.cpClient.sandboxGetTaskId.mockResolvedValueOnce({});
    await expect(provider.status("sb-queued")).resolves.toEqual({ state: "pending" });
    expect(client.cpClient.sandboxGetTaskId).toHaveBeenCalledWith({
      sandboxId: "sb-queued",
      timeout: 0,
      waitUntilReady: false,
    });
    client.cpClient.sandboxGetTaskId.mockResolvedValueOnce({ taskId: "ta-9" });
    await expect(provider.status("sb-queued")).resolves.toEqual({ state: "running" });
    await expect(provider.status("sb-queued")).resolves.toEqual({ state: "running" });
    expect(client.cpClient.sandboxGetTaskId).toHaveBeenCalledTimes(2);
  });

  it("resumes logs from stored cursors and keeps cursors on the end-of-stream batch", async () => {
    const { client } = fakeClient();
    client.cpClient.sandboxGetLogs.mockImplementation((request: { fileDescriptor: number }) =>
      request.fileDescriptor === 1
        ? batches([
            { entryId: "20-0", eof: false, items: [{ data: "second\n", timestamp: 20 }] },
            { entryId: "", eof: true, items: [] },
          ])
        : batches([{ entryId: "10-0", eof: false, items: [{ data: "warn\n", timestamp: 10 }] }]),
    );
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    const result = await provider.readLogs({
      providerResourceId: "sb-1",
      cursors: { stdout: "5-0" },
      complete: {},
      waitMs: 50,
      maxBytes: 1_024,
    });

    expect(client.cpClient.sandboxGetLogs).toHaveBeenCalledWith(
      { sandboxId: "sb-1", fileDescriptor: 1, timeout: 1, lastEntryId: "5-0" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.cpClient.sandboxGetLogs).toHaveBeenCalledWith(
      { sandboxId: "sb-1", fileDescriptor: 2, timeout: 1, lastEntryId: "0-0" },
      expect.anything(),
    );
    const decoder = new TextDecoder();
    expect(result.chunks.map((chunk) => [chunk.stream, decoder.decode(chunk.data)])).toEqual([
      ["stderr", "warn\n"],
      ["stdout", "second\n"],
    ]);
    expect(result.cursors).toEqual({ stdout: "20-0", stderr: "10-0" });
    expect(result.complete).toEqual({ stdout: true, stderr: false });
  });

  it("stops reading a stream that is already complete", async () => {
    const { client } = fakeClient();
    client.cpClient.sandboxGetLogs.mockReturnValue(
      batches([{ entryId: "", eof: true, items: [] }]),
    );
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    await provider.readLogs({
      providerResourceId: "sb-1",
      cursors: {},
      complete: { stdout: true },
      waitMs: 10,
      maxBytes: 1_024,
    });

    expect(client.cpClient.sandboxGetLogs).toHaveBeenCalledTimes(1);
    expect(client.cpClient.sandboxGetLogs.mock.calls[0]?.[0]).toMatchObject({ fileDescriptor: 2 });
  });

  it("prices metered GPU, CPU, and memory usage from the published rate card", async () => {
    const { client } = fakeClient();
    // Two T4 GPUs for 16 seconds with Modal's minimum CPU and memory reservation,
    // as reported by a live Modal GPU Sandbox.
    client.cpClient.sandboxGetResourceUsage.mockResolvedValue({
      cpuCoreNanosecs: 1_999_983_131,
      memGibNanosecs: 1_999_983_131,
      gpuNanosecs: 31_999_730_110,
      gpuType: "T4",
    });
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    const to = new Date("2026-09-27T10:00:00.000Z");

    const cost = await provider.getCost({
      providerResourceId: "sb-1",
      gpu: { type: "nvidia-t4", count: 2 },
      priceMultiplierBps: 10_000,
      from: new Date("2026-09-27T09:59:00.000Z"),
      to,
    });

    // 31.99973 GPU s * $0.000164 + 1.99998 core s * $0.00003942 + 1.99998 GiB s * $0.00000667
    expect(cost?.amountMicrousd).toBe(5_340n);
    const pinned = await provider.getCost({
      providerResourceId: "sb-1",
      gpu: { type: "nvidia-t4", count: 2 },
      priceMultiplierBps: 17_500,
      from: new Date("2026-09-27T09:59:00.000Z"),
      to,
    });
    expect(pinned?.amountMicrousd).toBe(9_345n);
    expect(pinned?.raw).toMatchObject({ baseMicrousd: "5340", priceMultiplierBps: 17_500 });
    expect(cost).toMatchObject({
      provenance: "provider_metered",
      measuredThrough: to,
      rateCardVersion: "modal-2026-09-27",
      raw: { billedGpuType: "nvidia-t4", usage: { gpuType: "T4" } },
    });
  });

  it("treats cancelling a missing Sandbox as complete", async () => {
    const { client, sandbox } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });

    await provider.cancel("sb-1");
    expect(sandbox.terminate).toHaveBeenCalledOnce();

    client.sandboxes.fromId.mockRejectedValueOnce(new NotFoundError("gone"));
    await expect(provider.cancel("sb-missing")).resolves.toBeUndefined();
  });

  it("pins regions and pulls private images with registry credentials", async () => {
    const cases = [
      [
        { kind: "basic", username: "bot", password: "pw" },
        "fromRegistry",
        { REGISTRY_USERNAME: "bot", REGISTRY_PASSWORD: "pw" },
      ],
      [
        { kind: "aws_ecr", accessKeyId: "AKIA", secretAccessKey: "sk", region: "us-east-1" },
        "fromAwsEcr",
        { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "sk", AWS_REGION: "us-east-1" },
      ],
      [
        { kind: "gcp_artifact_registry", serviceAccountJson: "{}" },
        "fromGcpArtifactRegistry",
        { SERVICE_ACCOUNT_JSON: "{}" },
      ],
    ] as const;
    for (const [registryAuth, method, secretValues] of cases) {
      const { client, secret } = fakeClient();
      const provider = new ModalGpuJobProvider({
        tokenId: "id",
        tokenSecret: "secret",
        client: client as never,
      });
      await provider.submit(submitInput({ registryAuth, regions: ["eu", "eu-west"] }));
      expect(client.secrets.fromObject).toHaveBeenCalledWith(secretValues, {
        environment: undefined,
      });
      expect(client.images[method]).toHaveBeenCalledWith("pytorch/pytorch:latest", secret);
      expect(client.sandboxes.create.mock.calls[0]?.[2]).toMatchObject({
        regions: ["eu", "eu-west"],
      });
    }
  });

  it("mounts S3, R2, and GCS buckets with their own credentials", async () => {
    const { client, secret } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    await provider.submit(
      submitInput({
        bucketMounts: [
          {
            provider: "r2",
            bucket: "outputs",
            mountPath: "/outputs",
            endpointUrl: "https://acct.r2.cloudflarestorage.com",
            keyPrefix: "run-1/",
            readOnly: false,
            credentials: { accessKeyId: "r2-id", secretAccessKey: "r2-secret" },
          },
          {
            provider: "gcs",
            bucket: "datasets",
            mountPath: "/data",
            readOnly: true,
            credentials: { accessKeyId: "gcs-id", secretAccessKey: "gcs-secret" },
          },
        ],
      }),
    );
    expect(client.secrets.fromObject).toHaveBeenCalledWith(
      { AWS_ACCESS_KEY_ID: "r2-id", AWS_SECRET_ACCESS_KEY: "r2-secret" },
      { environment: undefined },
    );
    expect(client.secrets.fromObject).toHaveBeenCalledWith(
      { GOOGLE_ACCESS_KEY_ID: "gcs-id", GOOGLE_ACCESS_KEY_SECRET: "gcs-secret" },
      { environment: undefined },
    );
    expect(client.cloudBucketMounts.create).toHaveBeenCalledWith("outputs", {
      secret,
      readOnly: false,
      keyPrefix: "run-1/",
      bucketEndpointUrl: "https://acct.r2.cloudflarestorage.com",
    });
    expect(client.cloudBucketMounts.create).toHaveBeenCalledWith("datasets", {
      secret,
      readOnly: true,
      bucketEndpointUrl: "https://storage.googleapis.com",
    });
    expect(Object.keys(client.sandboxes.create.mock.calls[0]?.[2].cloudBucketMounts)).toEqual([
      "/outputs",
      "/data",
    ]);
  });

  it("lists live Sandboxes in the app page by page with their job tags", async () => {
    const { client } = fakeClient();
    client.cpClient.sandboxList
      .mockResolvedValueOnce({
        sandboxes: [
          {
            id: "sb-2",
            createdAt: 200,
            tags: [
              { tagName: "metal.gpu_job_id", tagValue: "gpj_2" },
              { tagName: "metal.environment", tagValue: "production" },
            ],
          },
          { id: "sb-1", createdAt: 100, tags: [] },
        ],
      })
      .mockResolvedValueOnce({ sandboxes: [] });
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    await expect(provider.listActiveJobs()).resolves.toEqual([
      {
        providerResourceId: "sb-2",
        metalGpuJobId: "gpj_2",
        metalEnvironment: "production",
        createdAt: new Date(200_000),
      },
      {
        providerResourceId: "sb-1",
        metalGpuJobId: null,
        metalEnvironment: null,
        createdAt: new Date(100_000),
      },
    ]);
    expect(client.cpClient.sandboxList).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: "ap-1", beforeTimestamp: 100, includeFinished: false }),
    );
  });

  it("sums Modal's billed cost for the app over whole hours in the window", async () => {
    const { client } = fakeClient();
    const from = new Date("2026-09-26T00:00:00.000Z");
    const to = new Date("2026-09-27T00:00:00.000Z");
    client.cpClient.workspaceBillingReport.mockReturnValue(
      (async function* () {
        yield {
          objectId: "ap-1",
          interval: new Date("2026-09-26T08:00:00.000Z"),
          cost: "1.25000049",
          costByResource: { H100: "1.2", CPU: "0.05000049" },
        };
        yield {
          objectId: "ap-1",
          interval: new Date("2026-09-26T09:00:00.000Z"),
          cost: "0.5",
          costByResource: { H100: "0.5" },
        };
        yield { objectId: "ap-1", interval: to, cost: "9", costByResource: {} };
        yield { objectId: "ap-other", interval: from, cost: "7", costByResource: {} };
      })(),
    );
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    const reported = await provider.reportedCost({ from, to });
    expect(reported).toMatchObject({
      amountMicrousd: 1_750_000n,
      scope: "ap-1",
      raw: { intervals: 2, costByResourceMicrousd: { H100: "1700000", CPU: "50000" } },
    });
    expect(client.cpClient.workspaceBillingReport).toHaveBeenCalledWith(
      expect.objectContaining({ appIds: ["ap-1"], resolution: "h", startTimestamp: from }),
      expect.anything(),
    );
    expect(modalUsdToMicrousd("0.0000005")).toBe(1n);
    expect(modalUsdToMicrousd("12")).toBe(12_000_000n);
  });

  it("tags Sandboxes with the Metal environment and reads a task's start and finish", async () => {
    const { client } = fakeClient();
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      metalEnvironment: "production",
      client: client as never,
    });
    await provider.submit(submitInput());
    expect(client.sandboxes.create.mock.calls[0]?.[2].tags).toMatchObject({
      "metal.environment": "production",
    });

    client.cpClient.sandboxList.mockResolvedValueOnce({
      sandboxes: [
        { id: "sb-other", taskInfo: { startedAt: 1 } },
        { id: "sb-1", taskInfo: { startedAt: 1_790_530_000.5, finishedAt: 1_790_530_114.25 } },
      ],
    });
    await expect(
      provider.taskWindow({ providerResourceId: "sb-1", metalGpuJobId: "gpj_1" }),
    ).resolves.toEqual({
      startedAt: new Date(1_790_530_000_500),
      finishedAt: new Date(1_790_530_114_250),
    });
    expect(client.cpClient.sandboxList).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeFinished: true,
        tags: [{ tagName: "metal.gpu_job_id", tagValue: "gpj_1" }],
      }),
    );
    client.cpClient.sandboxList.mockResolvedValueOnce({
      sandboxes: [{ id: "sb-1", taskInfo: undefined }],
    });
    await expect(
      provider.taskWindow({ providerResourceId: "sb-1", metalGpuJobId: "gpj_1" }),
    ).resolves.toBeNull();
  });

  it("keeps usage counters beyond the safe integer range for large day-long jobs", () => {
    // 2 TiB of memory reserved for 24 hours.
    const memGibNanosecs = 2_048 * 86_400 * 1_000_000_000;
    expect(Number.isSafeInteger(memGibNanosecs)).toBe(false);
    expect(
      parseResourceUsage({ cpuCoreNanosecs: 0, memGibNanosecs, gpuNanosecs: "691200000000000" }),
    ).toEqual({
      cpuCoreNanosecs: 0n,
      memGibNanosecs: 176_947_200_000_000_000n,
      gpuNanosecs: 691_200_000_000_000n,
    });
    expect(parseResourceUsage({ cpuCoreNanosecs: -1, memGibNanosecs: 0, gpuNanosecs: 0 })).toBe(
      undefined,
    );
  });

  it("reports no billed cost before the managed app has been created", async () => {
    const { client } = fakeClient();
    client.apps.fromName.mockRejectedValueOnce(new NotFoundError("App 'metal-gpu-jobs' not found"));
    const provider = new ModalGpuJobProvider({
      tokenId: "id",
      tokenSecret: "secret",
      client: client as never,
    });
    await expect(
      provider.reportedCost({ from: new Date(0), to: new Date(3_600_000) }),
    ).resolves.toMatchObject({ amountMicrousd: 0n, scope: "app:metal-gpu-jobs" });
    expect(client.cpClient.workspaceBillingReport).not.toHaveBeenCalled();
  });
});
