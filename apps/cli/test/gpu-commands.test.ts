import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "../src/program.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

const JOB_ID = "gpj_test";

function gpuJob(state: string, exitCode: number | null) {
  const now = "2026-09-27T08:00:00.000Z";
  const terminal = ["succeeded", "failed", "timed_out", "cancelled"].includes(state);
  return {
    id: JOB_ID,
    type: "gpu_job",
    project_id: "prj_runtime",
    state,
    state_reason: state === "failed" ? "exit_code_nonzero" : null,
    failure:
      state === "failed"
        ? { code: "exit_code_nonzero", message: "process exited with code 3" }
        : null,
    provider: "modal",
    billing_mode: "managed",
    requested: {
      provider: "auto",
      source: { kind: "oci_image", image: "pytorch/pytorch:latest", command: ["python"] },
      gpu: { type: "nvidia-h100", count: 2 },
      lifecycle: { max_runtime_seconds: 900, max_start_seconds: 1_800 },
      secret_names: ["HF_TOKEN"],
    },
    resolved: null,
    pricing: {
      price_multiplier: "1.00",
      estimated_hourly_cost_usd: "7.898627",
      rate_card_version: "modal-2026-09-27",
    },
    exit_code: exitCode,
    cost_microusd: null,
    cost_updated_at: null,
    logs_complete: terminal,
    logs_truncated: false,
    created_at: now,
    updated_at: now,
    submitted_at: now,
    started_at: now,
    finished_at: terminal ? now : null,
    cancel_requested_at: null,
  };
}

function operation() {
  const now = "2026-09-27T08:00:00.000Z";
  return {
    id: "op_test",
    project_id: "prj_runtime",
    type: "gpu_job_create",
    state: "queued",
    resource_type: "gpu_job",
    resource_id: JOB_ID,
    retryable: false,
    error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

function logEvent(sequence: number, type: "stdout" | "stderr", text: string) {
  const event = {
    sequence,
    gpu_job_id: JOB_ID,
    type,
    occurred_at: "2026-09-27T08:00:00.000Z",
    data: {
      data_base64: Buffer.from(text).toString("base64"),
      byte_length: Buffer.byteLength(text),
      stream_offset_bytes: 0,
    },
  };
  return `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function gpuApi(finalState: { state: string; exitCode: number | null }) {
  const requests: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body?: unknown;
  }> = [];
  const server = createServer(async (request, response) => {
    const raw = await readBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined,
    });
    if (request.method === "POST" && request.url === "/v1/gpu/jobs") {
      response.setHeader("content-type", "application/json");
      response.statusCode = 202;
      response.end(JSON.stringify({ gpu_job: gpuJob("requested", null), operation: operation() }));
      return;
    }
    if (request.method === "GET" && request.url === `/v1/gpu/jobs/${JOB_ID}/logs`) {
      const after = Number(request.headers["last-event-id"] ?? 0);
      response.setHeader("content-type", "text/event-stream");
      response.end(
        after === 0 ? logEvent(1, "stdout", "epoch 1\n") + logEvent(2, "stderr", "warn\n") : "",
      );
      return;
    }
    if (request.method === "GET" && request.url === `/v1/gpu/jobs/${JOB_ID}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(gpuJob(finalState.state, finalState.exitCode)));
      return;
    }
    response.statusCode = 404;
    response.end(
      JSON.stringify({
        code: "not_found",
        message: "not found",
        request_id: "r",
        retryable: false,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function testRuntime(baseUrl: string, extraEnv: Record<string, string> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  Object.assign(stdout, { isTTY: false });
  Object.assign(stderr, { isTTY: false });
  const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: false });
  const value: CliRuntime = {
    env: {
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_API_KEY: "metal_sk_runtime",
      OPENMETAL_PROJECT_ID: "prj_runtime",
      ...extraEnv,
    },
    io: {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
  };
  return {
    value,
    stdout: () => Buffer.concat(stdoutChunks).toString(),
    stderr: () => Buffer.concat(stderrChunks).toString(),
  };
}

describe("GPU CLI commands", () => {
  it("maps flags to a GPU job request and reads secrets from the local environment", async () => {
    const fixture = await gpuApi({ state: "succeeded", exitCode: 0 });
    const runtime = testRuntime(fixture.baseUrl, {
      HF_TOKEN: "hf_local_secret",
      REGISTRY_TOKEN: "registry_local_secret",
    });

    await expect(
      runCli(
        [
          "gpu",
          "job",
          "create",
          "--image",
          "pytorch/pytorch:latest",
          "--gpu",
          "nvidia-h100",
          "--gpu-count",
          "2",
          "--max-runtime",
          "900",
          "--max-cost",
          "4.50",
          "--max-start",
          "600",
          "--region",
          "us",
          "eu",
          "--registry-username",
          "bot",
          "--registry-password-env",
          "REGISTRY_TOKEN",
          "--env",
          "EPOCHS=3",
          "--secret-env",
          "HF_TOKEN",
          "--idempotency-key",
          "gpu-cli-key",
          "--",
          "python",
          "train.py",
          "--lr",
          "0.1",
        ],
        runtime.value,
      ),
    ).resolves.toBe(0);

    const create = fixture.requests.find((request) => request.method === "POST");
    expect(create?.headers["idempotency-key"]).toBe("gpu-cli-key");
    expect(create?.headers["x-metal-project-id"]).toBe("prj_runtime");
    expect(create?.body).toEqual({
      provider: "auto",
      source: {
        kind: "oci_image",
        image: "pytorch/pytorch:latest",
        command: ["python", "train.py", "--lr", "0.1"],
        registry_auth: { kind: "basic", username: "bot", password: "registry_local_secret" },
      },
      gpu: { type: "nvidia-h100", count: 2 },
      lifecycle: { max_runtime_seconds: 900, max_start_seconds: 600 },
      placement: { regions: ["us", "eu"] },
      limits: { max_cost_usd: "4.50" },
      environment: { EPOCHS: "3" },
      secrets: { HF_TOKEN: "hf_local_secret" },
    });
    expect(runtime.stdout()).not.toContain("hf_local_secret");
    expect(runtime.stdout()).not.toContain("registry_local_secret");
    expect(JSON.parse(runtime.stdout())).toMatchObject({ gpu_job: { id: JOB_ID } });
  });

  it("follows logs to stdout and stderr and exits with the job's exit code", async () => {
    const fixture = await gpuApi({ state: "failed", exitCode: 3 });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(
        [
          "gpu",
          "job",
          "create",
          "--image",
          "pytorch/pytorch:latest",
          "--gpu",
          "nvidia-h100",
          "--follow",
          "--",
          "python",
          "train.py",
        ],
        runtime.value,
      ),
    ).resolves.toBe(3);

    expect(runtime.stdout()).toBe("epoch 1\n");
    expect(runtime.stderr()).toContain("warn\n");
    expect(runtime.stderr()).toContain(`${JOB_ID} failed (exit code 3)`);
  });

  it("rejects a missing local secret before contacting the API", async () => {
    const fixture = await gpuApi({ state: "succeeded", exitCode: 0 });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(
        [
          "gpu",
          "job",
          "create",
          "--image",
          "pytorch/pytorch:latest",
          "--gpu",
          "nvidia-t4",
          "--secret-env",
          "MISSING_TOKEN",
          "--",
          "python",
        ],
        runtime.value,
      ),
    ).resolves.toBe(1);

    expect(runtime.stderr()).toContain("environment variable MISSING_TOKEN is not set");
    expect(fixture.requests).toEqual([]);
  });
});
