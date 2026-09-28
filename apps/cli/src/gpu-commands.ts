import type { Command } from "commander";
import {
  CreateGpuJobRequestSchema,
  GpuJobStateSchema,
  GpuTypeSchema,
  type GpuJob,
} from "@openmetal/contracts";
import { projectClient } from "./clients.js";
import type { ResolvedSettings, RuntimeEnvironment } from "./config.js";
import { parseJsonInput } from "./input.js";
import type { CliIo } from "./io.js";
import { CliProcessExit } from "./runtime-commands.js";

type GpuCommandContext = {
  io: CliIo;
  env: RuntimeEnvironment;
  settings: () => Promise<ResolvedSettings>;
  output: (value: unknown) => void;
  json: () => boolean;
  confirmation: (message: string, localYes?: boolean) => Promise<void>;
};

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseAssignments(values: string[] | undefined, label: string) {
  if (!values?.length) return undefined;
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`${label} must be NAME=value: ${value}`);
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function secretsFromEnvironment(names: string[] | undefined, env: RuntimeEnvironment) {
  if (!names?.length) return undefined;
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined) throw new Error(`environment variable ${name} is not set`);
    secrets[name] = value;
  }
  return secrets;
}

function registryAuth(
  options: { registryUsername?: string; registryPasswordEnv?: string },
  env: RuntimeEnvironment,
) {
  if (!options.registryUsername && !options.registryPasswordEnv) return {};
  if (!options.registryUsername || !options.registryPasswordEnv) {
    throw new Error("--registry-username and --registry-password-env must be used together");
  }
  const password = env[options.registryPasswordEnv];
  if (password === undefined) {
    throw new Error(`environment variable ${options.registryPasswordEnv} is not set`);
  }
  return {
    registry_auth: { kind: "basic" as const, username: options.registryUsername, password },
  };
}

function jobExitCode(job: GpuJob): number {
  if (job.state === "succeeded") return 0;
  if (job.exit_code !== null && job.exit_code > 0 && job.exit_code < 256) return job.exit_code;
  return 1;
}

async function followLogs(
  context: GpuCommandContext,
  gpuJobId: string,
  lastEventId: number,
): Promise<void> {
  const client = projectClient(await context.settings());
  for await (const event of client.gpuJobs.logs(gpuJobId, { lastEventId })) {
    if (context.json()) {
      context.io.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.type === "truncated") {
      context.io.stderr.write(
        `[openmetal] log output exceeded ${event.data.limit_bytes} bytes; later output was not stored\n`,
      );
    } else {
      const stream = event.type === "stderr" ? context.io.stderr : context.io.stdout;
      stream.write(Buffer.from(event.data.data_base64, "base64"));
    }
  }
}

export function registerGpuCommands(program: Command, context: GpuCommandContext): void {
  const gpu = program.command("gpu").description("Run jobs on provider GPUs");
  gpu
    .command("types")
    .description("List GPU types, providers, limits, and per-second rates")
    .action(async () => {
      const client = projectClient(await context.settings());
      context.output(await client.gpu.types());
    });

  const job = gpu.command("job").description("Manage GPU jobs");
  job
    .command("create")
    .description("Run a container image to completion on GPUs")
    .argument("[command...]", "container command and arguments after --")
    .option("--file <path>", "read the full request from a JSON file")
    .option("--stdin", "read the full request as JSON from stdin")
    .option("--image <image>", "OCI image to run")
    .option("--gpu <type>", "GPU type, for example nvidia-h100")
    .option("--gpu-count <count>", "number of GPUs", "1")
    .option("--max-runtime <seconds>", "maximum runtime before the job is stopped", "3600")
    .option(
      "--max-start <seconds>",
      "fail the job if its container has not started this long after creation",
    )
    .option("--region <region...>", "run only in these regions; pinned regions cost more")
    .option("--registry-username <username>", "username for a private image registry")
    .option(
      "--registry-password-env <name>",
      "local environment variable holding the registry password or token",
    )
    .option("--max-cost <usd>", "cancel the job once its cost reaches this amount")
    .option("--provider <provider>", "provider or auto", "auto")
    .option("--workdir <path>", "working directory inside the container")
    .option("-e, --env <name=value...>", "environment variable")
    .option("--secret-env <name...>", "pass a local environment variable as a job secret")
    .option("--idempotency-key <key>")
    .option("--follow", "stream logs until the job finishes and exit with its status")
    .action(
      async (
        command: string[],
        options: {
          file?: string;
          stdin?: boolean;
          image?: string;
          gpu?: string;
          gpuCount: string;
          maxRuntime: string;
          maxStart?: string;
          region?: string[];
          registryUsername?: string;
          registryPasswordEnv?: string;
          maxCost?: string;
          provider: string;
          workdir?: string;
          env?: string[];
          secretEnv?: string[];
          idempotencyKey?: string;
          follow?: boolean;
        },
      ) => {
        const client = projectClient(await context.settings());
        const request =
          options.file || options.stdin
            ? await parseJsonInput(
                context.io,
                { file: options.file, stdin: options.stdin },
                CreateGpuJobRequestSchema,
              )
            : CreateGpuJobRequestSchema.parse({
                provider: options.provider,
                source: {
                  kind: "oci_image",
                  image: options.image,
                  command,
                  ...(options.workdir ? { working_dir: options.workdir } : {}),
                  ...registryAuth(options, context.env),
                },
                gpu: {
                  type: GpuTypeSchema.parse(options.gpu),
                  count: positiveInteger(options.gpuCount, "gpu-count"),
                },
                lifecycle: {
                  max_runtime_seconds: positiveInteger(options.maxRuntime, "max-runtime"),
                  ...(options.maxStart
                    ? { max_start_seconds: positiveInteger(options.maxStart, "max-start") }
                    : {}),
                },
                ...(options.region?.length ? { placement: { regions: options.region } } : {}),
                ...(options.maxCost ? { limits: { max_cost_usd: options.maxCost } } : {}),
                environment: parseAssignments(options.env, "environment"),
                secrets: secretsFromEnvironment(options.secretEnv, context.env),
              });
        const mutation = await client.gpuJobs.createAsync(request, {
          idempotencyKey: options.idempotencyKey,
        });
        if (!options.follow) {
          context.output(mutation);
          return;
        }
        context.io.stderr.write(`[openmetal] ${mutation.gpu_job.id} submitted\n`);
        await followLogs(context, mutation.gpu_job.id, 0);
        const finished = await client.gpuJobs.wait(mutation.gpu_job.id);
        context.io.stderr.write(
          `[openmetal] ${finished.id} ${finished.state}${
            finished.exit_code === null ? "" : ` (exit code ${finished.exit_code})`
          }\n`,
        );
        if (context.json()) context.output(finished);
        const exitCode = jobExitCode(finished);
        if (exitCode !== 0) {
          throw new CliProcessExit(exitCode, finished.failure?.message);
        }
      },
    );
  job
    .command("get")
    .argument("<gpu-job-id>")
    .action(async (gpuJobId: string) => {
      const client = projectClient(await context.settings());
      context.output(await client.gpuJobs.get(gpuJobId));
    });
  job
    .command("list")
    .option("--state <state>")
    .option("--cursor <cursor>")
    .option("--limit <number>")
    .action(async (options: { state?: string; cursor?: string; limit?: string }) => {
      const client = projectClient(await context.settings());
      context.output(
        await client.gpuJobs.list({
          state: options.state ? GpuJobStateSchema.parse(options.state) : undefined,
          cursor: options.cursor,
          limit: options.limit ? positiveInteger(options.limit, "limit") : undefined,
        }),
      );
    });
  job
    .command("logs")
    .description("Stream stdout and stderr until the job's logs are complete")
    .argument("<gpu-job-id>")
    .option("--after <sequence>", "last received log event sequence", "0")
    .action(async (gpuJobId: string, options: { after: string }) => {
      await followLogs(context, gpuJobId, nonnegativeInteger(options.after, "after"));
    });
  job
    .command("wait")
    .description("Wait until the job finishes and exit with its status")
    .argument("<gpu-job-id>")
    .option("--timeout <seconds>", "wait timeout", "86400")
    .action(async (gpuJobId: string, options: { timeout: string }) => {
      const client = projectClient(await context.settings());
      const finished = await client.gpuJobs.wait(gpuJobId, {
        timeoutMs: positiveInteger(options.timeout, "timeout") * 1_000,
      });
      context.output(finished);
      const exitCode = jobExitCode(finished);
      if (exitCode !== 0) throw new CliProcessExit(exitCode);
    });
  job
    .command("cancel")
    .argument("<gpu-job-id>")
    .option("--wait", "wait until the job is cancelled")
    .option("-y, --yes")
    .action(async (gpuJobId: string, options: { wait?: boolean; yes?: boolean }) => {
      await context.confirmation(`Cancel GPU job ${gpuJobId}`, options.yes);
      const client = projectClient(await context.settings());
      const mutation = await client.gpuJobs.cancelAsync(gpuJobId);
      context.output(options.wait ? await client.gpuJobs.wait(gpuJobId) : mutation);
    });
}
