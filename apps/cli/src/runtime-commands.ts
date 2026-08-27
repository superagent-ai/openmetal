import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import type { Process, ProcessEvent, RuntimeOperation } from "@openmetal/contracts";
import { projectClient } from "./clients.js";
import type { ResolvedSettings } from "./config.js";
import type { CliIo } from "./io.js";

const TERMINAL_PROCESS_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export class CliProcessExit extends Error {
  constructor(
    readonly exitCode: number,
    readonly detail?: string,
  ) {
    super(detail ?? `process exited with code ${exitCode}`);
  }
}

export class CliProcessStreamError extends Error {
  constructor(
    readonly processId: string,
    readonly idempotencyKey: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CliProcessStreamError";
  }
}

type RuntimeCommandContext = {
  io: CliIo;
  settings: () => Promise<ResolvedSettings>;
  output: (value: unknown) => void;
  json: () => boolean;
  confirmation: (message: string, localYes?: boolean) => Promise<void>;
};

export function registerRuntimeCommands(program: Command, context: RuntimeCommandContext): void {
  registerExecCommand(program, context);
  registerProcessCommands(program, context);
  registerFileCommands(program, context);
  registerEndpointCommands(program, context);
}

function registerExecCommand(program: Command, context: RuntimeCommandContext): void {
  const sandbox = program.commands.find((command) => command.name() === "sandbox");
  if (!sandbox) throw new Error("sandbox command must be registered before runtime commands");

  sandbox
    .command("exec")
    .description("Execute a command in a sandbox")
    .argument("<sandbox-id>")
    .argument("<argv...>", "command and arguments after --")
    .option("--cwd <path>")
    .option("-e, --env <name=value...>", "environment variable")
    .option("--timeout <seconds>", "process timeout", "300")
    .option("--max-output-bytes <bytes>", "maximum captured output", "10485760")
    .option("--idempotency-key <key>")
    .action(
      async (
        sandboxId: string,
        argv: string[],
        options: {
          cwd?: string;
          env?: string[];
          timeout: string;
          maxOutputBytes: string;
          idempotencyKey?: string;
        },
      ) => {
        const client = projectClient(await context.settings());
        const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
        const created = await client.processes.create(
          sandboxId,
          {
            command: argv,
            cwd: options.cwd,
            environment: parseEnvironment(options.env),
            timeout_seconds: positiveInteger(options.timeout, "timeout"),
            max_output_bytes: positiveInteger(options.maxOutputBytes, "max-output-bytes"),
          },
          { idempotencyKey },
        );
        const events: ProcessEvent[] = [];
        let completed: Process;
        try {
          if (!TERMINAL_PROCESS_STATES.has(created.state)) {
            await consumeProcessEvents(client, sandboxId, created.id, 0, context, events);
          }
          completed = await client.processes.get(sandboxId, created.id);
        } catch (error) {
          throw new CliProcessStreamError(created.id, idempotencyKey, error);
        }
        if (context.json()) context.output({ process: completed, events });

        const remoteExitCode = processRemoteExitCode(completed, events);
        const exitCode = remoteExitCode ?? (completed.state === "succeeded" ? 0 : 1);
        if (exitCode !== 0) {
          throw new CliProcessExit(
            exitCode,
            remoteExitCode === undefined ? completed.error?.message : undefined,
          );
        }
      },
    );
}

function registerProcessCommands(program: Command, context: RuntimeCommandContext): void {
  const processCommand = program.command("process").description("Inspect and control processes");
  processCommand
    .command("get")
    .argument("<sandbox-id>")
    .argument("<process-id>")
    .action(async (sandboxId: string, processId: string) => {
      const client = projectClient(await context.settings());
      context.output(await client.processes.get(sandboxId, processId));
    });
  processCommand
    .command("cancel")
    .argument("<sandbox-id>")
    .argument("<process-id>")
    .option("--idempotency-key <key>")
    .option("-y, --yes")
    .action(
      async (
        sandboxId: string,
        processId: string,
        options: { idempotencyKey?: string; yes?: boolean },
      ) => {
        await context.confirmation(`Cancel process ${processId}`, options.yes);
        const client = projectClient(await context.settings());
        context.output(
          await client.processes.cancel(sandboxId, processId, {
            idempotencyKey: options.idempotencyKey,
          }),
        );
      },
    );
  processCommand
    .command("events")
    .description("Stream process events until the process terminates")
    .argument("<sandbox-id>")
    .argument("<process-id>")
    .option("--after <sequence>", "last received event sequence", "0")
    .action(
      async (
        sandboxId: string,
        processId: string,
        options: {
          after: string;
        },
      ) => {
        const client = projectClient(await context.settings());
        const events: ProcessEvent[] = [];
        await consumeProcessEvents(
          client,
          sandboxId,
          processId,
          nonnegativeInteger(options.after, "after"),
          context,
          events,
        );
        if (context.json()) {
          context.output({
            events,
            process: await client.processes.get(sandboxId, processId),
          });
        }
      },
    );
}

function registerFileCommands(program: Command, context: RuntimeCommandContext): void {
  const file = program.command("file").description("Manage sandbox files");
  file
    .command("upload")
    .alias("write")
    .description("Upload a local file; use - to read stdin")
    .argument("<sandbox-id>")
    .argument("<local-path>")
    .argument("<remote-path>")
    .option("--mode <mode>", "create, overwrite, or append", "overwrite")
    .option("--create-parents")
    .option("--idempotency-key <key>")
    .option("--timeout <seconds>", "wait timeout", "180")
    .action(
      async (
        sandboxId: string,
        localPath: string,
        remotePath: string,
        options: {
          mode: string;
          createParents?: boolean;
          idempotencyKey?: string;
          timeout: string;
        },
      ) => {
        const data =
          localPath === "-" ? await readAllBytes(context.io.stdin) : await readFile(localPath);
        const client = projectClient(await context.settings());
        const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
        const completed = await client.filesystem.upload(sandboxId, remotePath, data, {
          mode: fileMode(options.mode),
          createParents: options.createParents,
          idempotencyKey,
          timeoutMs: secondsToMilliseconds(options.timeout),
        });
        context.output(requireRuntimeResult(completed));
      },
    );
  file
    .command("download")
    .alias("read")
    .description("Download a file; omit local path to write bytes to stdout")
    .argument("<sandbox-id>")
    .argument("<remote-path>")
    .argument("[local-path]")
    .option("--offset <bytes>", "starting byte offset", "0")
    .option("--chunk-size <bytes>", "bytes per request", "1048576")
    .option("--timeout <seconds>", "wait timeout", "180")
    .action(
      async (
        sandboxId: string,
        remotePath: string,
        localPath: string | undefined,
        options: { offset: string; chunkSize: string; timeout: string },
      ) => {
        const client = projectClient(await context.settings());
        const bytes = await client.filesystem.download(sandboxId, remotePath, {
          offsetBytes: nonnegativeInteger(options.offset, "offset"),
          limitBytes: positiveInteger(options.chunkSize, "chunk-size"),
          timeoutMs: secondsToMilliseconds(options.timeout),
        });
        if (localPath && localPath !== "-") {
          await writeFile(localPath, bytes);
          context.output({
            path: remotePath,
            local_path: localPath,
            byte_length: bytes.byteLength,
          });
        } else if (context.json()) {
          context.output({
            path: remotePath,
            data_base64: Buffer.from(bytes).toString("base64"),
            byte_length: bytes.byteLength,
          });
        } else {
          context.io.stdout.write(Buffer.from(bytes));
        }
      },
    );
  file
    .command("list")
    .argument("<sandbox-id>")
    .argument("<path>")
    .option("--recursive")
    .option("--max-entries <number>", "maximum returned entries", "1000")
    .option("--timeout <seconds>", "wait timeout", "180")
    .action(
      async (
        sandboxId: string,
        path: string,
        options: { recursive?: boolean; maxEntries: string; timeout: string },
      ) => {
        const client = projectClient(await context.settings());
        const operation = await client.filesystem.list(sandboxId, {
          path,
          recursive: options.recursive,
          max_entries: positiveInteger(options.maxEntries, "max-entries"),
        });
        const completed = await client.runtimeOperations.wait(operation, {
          timeoutMs: secondsToMilliseconds(options.timeout),
        });
        context.output(requireRuntimeResult(completed));
      },
    );
  file
    .command("delete")
    .argument("<sandbox-id>")
    .argument("<path>")
    .option("--recursive")
    .option("--idempotency-key <key>")
    .option("--timeout <seconds>", "wait timeout", "180")
    .option("-y, --yes")
    .action(
      async (
        sandboxId: string,
        path: string,
        options: {
          recursive?: boolean;
          idempotencyKey?: string;
          timeout: string;
          yes?: boolean;
        },
      ) => {
        await context.confirmation(`Delete ${path} from sandbox ${sandboxId}`, options.yes);
        const client = projectClient(await context.settings());
        const operation = await client.filesystem.delete(
          sandboxId,
          { path, recursive: options.recursive },
          { idempotencyKey: options.idempotencyKey },
        );
        const completed = await client.runtimeOperations.wait(operation, {
          timeoutMs: secondsToMilliseconds(options.timeout),
        });
        context.output(requireRuntimeResult(completed));
      },
    );
}

function registerEndpointCommands(program: Command, context: RuntimeCommandContext): void {
  const endpoint = program.command("endpoint").description("Manage sandbox HTTP endpoints");
  endpoint
    .command("expose")
    .argument("<sandbox-id>")
    .requiredOption("--port <port>")
    .option("--lease-seconds <seconds>", "endpoint lease duration", "3600")
    .option("--idempotency-key <key>")
    .action(
      async (
        sandboxId: string,
        options: { port: string; leaseSeconds: string; idempotencyKey?: string },
      ) => {
        const client = projectClient(await context.settings());
        context.output(
          await client.endpoints.create(
            sandboxId,
            {
              port: positiveInteger(options.port, "port"),
              protocol: "http",
              lease_seconds: positiveInteger(options.leaseSeconds, "lease-seconds"),
            },
            { idempotencyKey: options.idempotencyKey },
          ),
        );
      },
    );
  endpoint
    .command("list")
    .argument("<sandbox-id>")
    .option("--cursor <cursor>")
    .option("--limit <number>", "page size", "50")
    .action(
      async (
        sandboxId: string,
        options: {
          cursor?: string;
          limit: string;
        },
      ) => {
        const client = projectClient(await context.settings());
        context.output(
          await client.endpoints.list(sandboxId, {
            cursor: options.cursor,
            limit: positiveInteger(options.limit, "limit"),
          }),
        );
      },
    );
  endpoint
    .command("revoke")
    .argument("<sandbox-id>")
    .argument("<endpoint-id>")
    .option("-y, --yes")
    .action(async (sandboxId: string, endpointId: string, options: { yes?: boolean }) => {
      await context.confirmation(`Revoke endpoint ${endpointId}`, options.yes);
      const client = projectClient(await context.settings());
      context.output(await client.endpoints.revoke(sandboxId, endpointId));
    });
}

async function consumeProcessEvents(
  client: ReturnType<typeof projectClient>,
  sandboxId: string,
  processId: string,
  after: number,
  context: RuntimeCommandContext,
  collected: ProcessEvent[],
): Promise<void> {
  for await (const event of client.processes.events(sandboxId, processId, {
    lastEventId: after,
  })) {
    if (context.json()) {
      collected.push(event);
    } else if (event.type === "stdout" || event.type === "stderr") {
      const bytes = Buffer.from(event.data.data_base64, "base64");
      const stream = event.type === "stdout" ? context.io.stdout : context.io.stderr;
      stream.write(bytes);
    }
  }
}

function processRemoteExitCode(completed: Process, events: ProcessEvent[]): number | undefined {
  if (completed.exit_code !== null) return completed.exit_code;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "exited") return event.data.exit_code;
  }
  return undefined;
}

function requireRuntimeResult(
  operation: RuntimeOperation,
): NonNullable<RuntimeOperation["result"]> {
  if (operation.state !== "succeeded" || !operation.result) {
    throw new Error(
      operation.error?.message ?? `runtime operation ${operation.id} ${operation.state}`,
    );
  }
  return operation.result;
}

function parseEnvironment(values?: string[]): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const environment: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`environment must be NAME=value: ${value}`);
    environment[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return environment;
}

function fileMode(value: string): "create" | "overwrite" | "append" {
  if (value === "create" || value === "overwrite" || value === "append") return value;
  throw new Error("mode must be create, overwrite, or append");
}

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

function secondsToMilliseconds(value: string): number {
  return positiveInteger(value, "timeout") * 1000;
}

async function readAllBytes(stream: NodeJS.ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
