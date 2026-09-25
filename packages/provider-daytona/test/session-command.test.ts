import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DaytonaSandboxProvider } from "../src/index.js";

const setsidAvailable = spawnSync("sh", ["-c", "setsid -w true"]).status === 0;
const busyboxAvailable = spawnSync("sh", ["-c", "command -v busybox"]).status === 0;
const bashAvailable = spawnSync("sh", ["-c", "command -v bash"]).status === 0;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const pidFile = join(directory, "heartbeat.pid");
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // The heartbeat already exited.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

async function sessionCommand(input: {
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
}): Promise<string> {
  let sessionCommandText = "";
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (path.endsWith("/exec")) {
      sessionCommandText = JSON.parse(String(init?.body)).command;
      return Response.json({ cmdId: "command-1" });
    }
    if (path.endsWith("/command/command-1")) {
      return Response.json({ id: "command-1", command: "", exitCode: 0 });
    }
    if (path.endsWith("/logs")) return Response.json({ stdout: "", stderr: "" });
    return new Response(null, { status: 204 });
  });
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const execution = await provider.exec({ providerResourceId: "sandbox-1", ...input });
  for await (const _event of execution.events) {
    // Drain the fake execution so the adapter releases its session.
  }
  return sessionCommandText;
}

async function runAsDaytonaSession(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  shell = "sh",
) {
  const session = spawn(shell, ["-c", command], {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  session.stdout.on("data", (chunk) => (stdout += chunk));
  const [exitCode] = await once(session, "exit");
  return { exitCode: exitCode as number, stdout, processGroup: session.pid! };
}

function killSessionProcessGroup(processGroup: number) {
  try {
    process.kill(-processGroup, "SIGKILL");
  } catch {
    // No process is left in the session's group.
  }
}

function heartbeatCommand(directory: string): string[] {
  const file = join(directory, "heartbeat.log");
  const pidFile = join(directory, "heartbeat.pid");
  return [
    "sh",
    "-c",
    `nohup sh -c 'echo $$ > ${pidFile}; while true; do echo beat >> ${file}; sleep 0.1; done' >/dev/null 2>&1 &`,
  ];
}

function beats(directory: string): number {
  try {
    return readFileSync(join(directory, "heartbeat.log"), "utf8").split("\n").length - 1;
  } catch {
    return 0;
  }
}

async function heartbeatSurvivesSessionDeletion(
  command: string,
  directory: string,
  env?: NodeJS.ProcessEnv,
) {
  const session = await runAsDaytonaSession(command, env);
  expect(session.exitCode).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  killSessionProcessGroup(session.processGroup);
  const afterDeletion = beats(directory);
  await new Promise((resolve) => setTimeout(resolve, 600));
  return beats(directory) > afterDeletion;
}

it.skipIf(!setsidAvailable)(
  "keeps detached processes running after the Daytona session is deleted",
  async () => {
    const legacy = mkdtempSync(join(tmpdir(), "daytona-legacy-"));
    const launched = mkdtempSync(join(tmpdir(), "daytona-launched-"));
    directories.push(legacy, launched);

    const legacyCommand = heartbeatCommand(legacy)
      .map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`)
      .join(" ");
    expect(await heartbeatSurvivesSessionDeletion(legacyCommand, legacy)).toBe(false);

    const command = await sessionCommand({ command: heartbeatCommand(launched) });
    expect(await heartbeatSurvivesSessionDeletion(command, launched)).toBe(true);
  },
);

function busyboxSetsidEnv(directory: string): NodeJS.ProcessEnv {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(
    spawnSync("sh", ["-c", "command -v busybox"]).stdout.toString().trim(),
    join(bin, "setsid"),
  );
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

it.skipIf(!busyboxAvailable)(
  "keeps detached processes running with BusyBox setsid, which has no -w",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "daytona-busybox-"));
    directories.push(directory);
    const env = busyboxSetsidEnv(directory);
    expect(spawnSync("sh", ["-c", "setsid -w true"], { env }).status).not.toBe(0);

    const command = await sessionCommand({ command: heartbeatCommand(directory) });
    expect(await heartbeatSurvivesSessionDeletion(command, directory, env)).toBe(true);
  },
);

it.skipIf(!busyboxAvailable || !bashAvailable)(
  "keeps the exit code when BusyBox setsid would fork under job control",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "daytona-job-control-"));
    directories.push(directory);
    const env = busyboxSetsidEnv(directory);
    const command = await sessionCommand({ command: ["sh", "-c", "sleep 0.2; exit 7"] });

    const session = await runAsDaytonaSession(`set -m; ${command}`, env, "bash");
    killSessionProcessGroup(session.processGroup);
    expect(session.exitCode).toBe(7);
  },
);

it("preserves the command's exit code, output, working directory, and environment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daytona-command-"));
  directories.push(directory);
  const command = await sessionCommand({
    command: ["sh", "-c", `printf '%s %s' "$PWD" "$METAL_VALUE"; exit 7`],
    cwd: directory,
    environment: { METAL_VALUE: "it's quoted" },
  });

  const session = await runAsDaytonaSession(command);
  killSessionProcessGroup(session.processGroup);
  expect(session).toMatchObject({ exitCode: 7, stdout: `${directory} it's quoted` });
});
