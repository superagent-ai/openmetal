import { Command, CommanderError } from "commander";
import {
  CreateSandboxRequestSchema,
  ProviderCredentialInputSchema,
  SandboxProviderSchema,
  type InvitationRole,
  type Operation,
  type OperationEvent,
} from "@openmetal/contracts";
import { MetalError, RuntimeOperationWaitError } from "@openmetal/sdk";
import { z } from "zod";
import { authStatus, login, logout, openExternalUrl } from "./auth.js";
import { anonymousClient, projectClient, userClient } from "./clients.js";
import {
  loadConfig,
  removeProjectKey,
  resolveSettings,
  setActiveProfile,
  storeProjectKey,
  updateProfile,
  type ResolvedSettings,
  type RuntimeEnvironment,
} from "./config.js";
import { parseJsonInput } from "./input.js";
import {
  choose,
  confirm,
  processIo,
  promptLine,
  promptSecret,
  writeError,
  writeResult,
  writeText,
  type CliIo,
} from "./io.js";
import {
  CliProcessExit,
  CliProcessStreamError,
  registerRuntimeCommands,
} from "./runtime-commands.js";

declare const __OPENMETAL_VERSION__: string;
declare const __OPENMETAL_COMMIT__: string;

const VERSION = typeof __OPENMETAL_VERSION__ === "string" ? __OPENMETAL_VERSION__ : "0.1.0-dev";
const COMMIT = typeof __OPENMETAL_COMMIT__ === "string" ? __OPENMETAL_COMMIT__ : "development";
const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled"]);

type GlobalOptions = {
  profile?: string;
  apiUrl?: string;
  organization?: string;
  project?: string;
  accessToken?: string;
  apiKey?: string;
  json?: boolean;
  yes?: boolean;
  input?: boolean;
  color?: boolean;
};

export type CliRuntime = {
  io: CliIo;
  env: RuntimeEnvironment;
};

export async function runCli(
  argv: string[],
  runtime: CliRuntime = { io: processIo, env: process.env },
): Promise<number> {
  const program = createProgram(runtime);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof CliProcessExit) {
      if (error.detail) writeError(runtime.io, error.detail);
      return error.exitCode;
    }
    if (error instanceof CliProcessStreamError) {
      const cause = error.cause;
      if (cause instanceof MetalError) {
        writeError(runtime.io, cause.message, { code: cause.code, requestId: cause.requestId });
      } else {
        writeError(runtime.io, error.message);
      }
      runtime.io.stderr.write(`process_id: ${error.processId}\n`);
      runtime.io.stderr.write(`idempotency_key: ${error.idempotencyKey}\n`);
      return cause instanceof MetalError ? metalErrorExitCode(cause) : 1;
    }
    if (error instanceof RuntimeOperationWaitError) {
      const cause = error.cause;
      if (cause instanceof MetalError) {
        writeError(runtime.io, cause.message, { code: cause.code, requestId: cause.requestId });
      } else {
        writeError(runtime.io, error.message);
      }
      runtime.io.stderr.write(`runtime_operation_id: ${error.operationId}\n`);
      runtime.io.stderr.write(`idempotency_key: ${error.idempotencyKey}\n`);
      return cause instanceof MetalError ? metalErrorExitCode(cause) : 1;
    }
    if (error instanceof MetalError) {
      writeError(runtime.io, error.message, { code: error.code, requestId: error.requestId });
      if (error.idempotencyKey) {
        runtime.io.stderr.write(`idempotency_key: ${error.idempotencyKey}\n`);
      }
      return metalErrorExitCode(error);
    }
    if (error instanceof z.ZodError) {
      writeError(runtime.io, error.issues.map((issue) => issue.message).join("; "), {
        code: "validation_error",
      });
      return 2;
    }
    writeError(runtime.io, error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function metalErrorExitCode(error: MetalError): number {
  return error.status === 401 || error.status === 403 ? 3 : error.code === "timeout" ? 4 : 1;
}

export function createProgram(runtime: CliRuntime): Command {
  const { io, env } = runtime;
  const program = new Command();
  program
    .name("openmetal")
    .description("Manage OpenMetal organizations, projects, and sandboxes")
    .version(VERSION)
    .option("--profile <name>", "configuration profile")
    .option("--api-url <url>", "Metal API origin")
    .option("--organization <id>", "organization context")
    .option("--project <id>", "project context")
    .option("--access-token <token>", "user access token")
    .option("--api-key <key>", "project API key")
    .option("--json", "emit stable JSON")
    .option("-y, --yes", "confirm destructive actions")
    .option("--no-input", "disable interactive prompts")
    .option("--no-color", "disable ANSI color")
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    })
    .exitOverride();

  const globalOptions = () => program.opts<GlobalOptions>();
  const settings = () => {
    const options = globalOptions();
    return resolveSettings(
      {
        profile: options.profile,
        apiUrl: options.apiUrl,
        organizationId: options.organization,
        projectId: options.project,
        accessToken: options.accessToken,
        apiKey: options.apiKey,
      },
      env,
    );
  };
  const output = (value: unknown) =>
    writeResult(io, value, {
      json: globalOptions().json,
      color: globalOptions().color,
    });
  const confirmation = (message: string, localYes?: boolean) =>
    confirm(io, message, {
      yes: localYes ?? globalOptions().yes,
      noInput: globalOptions().input === false,
    });

  registerCoreCommands(program, runtime, settings, output);
  registerOrganizationCommands(program, runtime, settings, output);
  registerProjectCommands(program, runtime, settings, output, confirmation);
  registerCredentialCommands(program, runtime, settings, output, confirmation);
  registerComputeCommands(program, runtime, settings, output, confirmation);
  registerRuntimeCommands(program, {
    io,
    settings,
    output,
    json: () => Boolean(globalOptions().json),
    confirmation,
  });
  registerTeamCommands(program, runtime, settings, output, confirmation);
  registerBillingCommands(program, runtime, settings, output);
  registerSetupCommand(program, runtime, settings, output);

  return program;
}

function registerCoreCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
): void {
  const { io, env } = runtime;

  const auth = program.command("auth").description("Manage browser authentication");
  auth
    .command("login")
    .option("--provider <provider>", "OAuth provider", "github")
    .option("--no-browser", "print the login URL without opening a browser")
    .action(async (options: { provider: string; browser: boolean }) => {
      const provider = z.enum(["github", "google"]).parse(options.provider);
      const resolved = await settings();
      const session = await login(resolved, io, { provider, openBrowser: options.browser }, env);
      output({
        authenticated: true,
        profile: resolved.profileName,
        user_id: session.user?.id,
        email: session.user?.email,
      });
    });
  auth.command("logout").action(async () => {
    const resolved = await settings();
    await logout(resolved.profileName, env);
    output({ authenticated: false, profile: resolved.profileName });
  });
  auth.command("status").action(async () => output(await authStatus(await settings(), env)));

  const config = program.command("config").description("Manage local configuration");
  config.command("show").action(async () => {
    const resolved = await settings();
    const stored = await loadConfig(env);
    output({
      active_profile: stored.activeProfile,
      profile: resolved.profileName,
      api_url: resolved.apiUrl,
      supabase_url: resolved.supabaseUrl,
      organization_id: resolved.organizationId,
      project_id: resolved.projectId,
      user_token_configured: Boolean(resolved.accessToken),
      api_key_configured: Boolean(resolved.apiKey),
    });
  });
  config
    .command("set")
    .option("--api-url <url>")
    .option("--supabase-url <url>")
    .option("--supabase-publishable-key <key>")
    .option("--organization <id>")
    .option("--project <id>")
    .action(
      async (options: {
        apiUrl?: string;
        supabaseUrl?: string;
        supabasePublishableKey?: string;
        organization?: string;
        project?: string;
      }) => {
        const resolved = await settings();
        const globals = program.opts<GlobalOptions>();
        const profile = await updateProfile(
          resolved.profileName,
          {
            apiUrl: options.apiUrl ?? globals.apiUrl,
            supabaseUrl: options.supabaseUrl,
            supabasePublishableKey: options.supabasePublishableKey,
            organizationId: options.organization ?? globals.organization,
            projectId: options.project ?? globals.project,
          },
          env,
        );
        output({ profile: resolved.profileName, ...profile });
      },
    );
  config
    .command("use-profile")
    .argument("<name>")
    .action(async (name: string) => {
      await setActiveProfile(name, env);
      output({ active_profile: name });
    });

  const context = program.command("context").description("Manage active organization and project");
  context.command("show").action(async () => {
    const resolved = await settings();
    output({
      profile: resolved.profileName,
      organization_id: resolved.organizationId,
      project_id: resolved.projectId,
    });
  });
  context
    .command("use")
    .option("--organization <id>")
    .option("--project <id>")
    .action(async (options: { organization?: string; project?: string }) => {
      const globals = program.opts<GlobalOptions>();
      const organizationId = options.organization ?? globals.organization;
      const projectId = options.project ?? globals.project;
      if (!organizationId && !projectId) {
        throw new Error("provide --organization and/or --project");
      }
      const resolved = await settings();
      const profile = await updateProfile(resolved.profileName, { organizationId, projectId }, env);
      output({
        profile: resolved.profileName,
        organization_id: profile.organizationId,
        project_id: profile.projectId,
      });
    });

  program
    .command("health")
    .action(async () => output(await anonymousClient(await settings()).health()));
  program
    .command("ready")
    .action(async () => output(await anonymousClient(await settings()).ready()));
  program
    .command("meta")
    .action(async () => output(await anonymousClient(await settings()).meta()));
  program.command("doctor").action(async () => {
    const resolved = await settings();
    const checks: Record<string, unknown>[] = [];
    try {
      const health = await anonymousClient(resolved).health();
      checks.push({ check: "api", status: "ok", detail: health.status });
    } catch (error) {
      checks.push({
        check: "api",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const status = await authStatus(resolved, env);
    if (status.authenticated) {
      try {
        await userClient(resolved, env).organizations.list();
        checks.push({
          check: "user_auth",
          status: "ok",
          detail: status.email ?? status.source ?? "",
        });
      } catch (error) {
        checks.push({
          check: "user_auth",
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      checks.push({ check: "user_auth", status: "missing", detail: "" });
    }
    checks.push({
      check: "project_context",
      status: resolved.projectId ? "ok" : "missing",
      detail: resolved.projectId ?? "",
    });
    if (resolved.apiKey && resolved.projectId) {
      try {
        await projectClient(resolved).sandboxes.listScoped({ limit: 1 });
        checks.push({ check: "project_key", status: "ok", detail: "authorized" });
      } catch (error) {
        checks.push({
          check: "project_key",
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      checks.push({ check: "project_key", status: "missing", detail: "" });
    }
    output(checks);
    if (checks.some((check) => check.status === "error")) throw new Error("doctor checks failed");
  });

  program
    .command("completion")
    .argument("<shell>", "bash, zsh, fish, or powershell")
    .action((shell: string) => writeText(io, completionScript(shell)));
  program.command("version").action(() => output({ version: VERSION, commit: COMMIT }));
}

function registerOrganizationCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
): void {
  const { env } = runtime;
  const org = program.command("org").alias("organization").description("Manage organizations");
  org.command("list").action(async () => {
    const resolved = await settings();
    output((await userClient(resolved, env).organizations.list()).organizations);
  });
  org
    .command("get")
    .argument("[organization-id]")
    .action(async (organizationId?: string) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).organizations.get(
          requireOrganization(resolved, organizationId),
        ),
      );
    });
  org
    .command("create")
    .requiredOption("--name <name>")
    .requiredOption("--slug <slug>")
    .option("--idempotency-key <key>")
    .action(async (options: { name: string; slug: string; idempotencyKey?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).organizations.create(
          { name: options.name, slug: options.slug },
          { idempotencyKey: options.idempotencyKey },
        ),
      );
    });
}

function registerProjectCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
  confirmation: (message: string, localYes?: boolean) => Promise<void>,
): void {
  const { env } = runtime;
  const project = program.command("project").description("Manage projects");
  project
    .command("list")
    .option("--organization <id>")
    .action(async (options: { organization?: string }) => {
      const resolved = await settings();
      const id = requireOrganization(resolved, options.organization);
      output((await userClient(resolved, env).projects.list(id)).projects);
    });
  project
    .command("get")
    .argument("[project-id]")
    .action(async (projectId?: string) => {
      const resolved = await settings();
      output(await userClient(resolved, env).projects.get(requireProject(resolved, projectId)));
    });
  project
    .command("create")
    .requiredOption("--name <name>")
    .requiredOption("--slug <slug>")
    .option("--organization <id>")
    .option("--idempotency-key <key>")
    .option("--use", "make the new project active")
    .action(
      async (options: {
        name: string;
        slug: string;
        organization?: string;
        idempotencyKey?: string;
        use?: boolean;
      }) => {
        const resolved = await settings();
        const organizationId = requireOrganization(resolved, options.organization);
        const created = await userClient(resolved, env).projects.create(
          organizationId,
          { name: options.name, slug: options.slug },
          { idempotencyKey: options.idempotencyKey },
        );
        if (options.use) {
          await updateProfile(resolved.profileName, { organizationId, projectId: created.id }, env);
        }
        output(created);
      },
    );
  project
    .command("update")
    .argument("[project-id]")
    .requiredOption("--name <name>")
    .requiredOption("--slug <slug>")
    .action(async (projectId: string | undefined, options: { name: string; slug: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).projects.update(requireProject(resolved, projectId), {
          name: options.name,
          slug: options.slug,
        }),
      );
    });
  project
    .command("delete")
    .argument("[project-id]")
    .option("-y, --yes")
    .action(async (projectId: string | undefined, options: { yes?: boolean }) => {
      const resolved = await settings();
      const id = requireProject(resolved, projectId);
      await confirmation(`Delete project ${id}`, options.yes);
      output(await userClient(resolved, env).projects.delete(id));
    });
  project
    .command("use")
    .argument("<project-id>")
    .option("--organization <id>")
    .action(async (projectId: string, options: { organization?: string }) => {
      const resolved = await settings();
      const found = await userClient(resolved, env).projects.get(projectId);
      const organizationId =
        options.organization ?? program.opts<GlobalOptions>().organization ?? found.organization_id;
      await updateProfile(resolved.profileName, { projectId: found.id, organizationId }, env);
      output({
        profile: resolved.profileName,
        organization_id: organizationId,
        project_id: found.id,
      });
    });
}

function registerCredentialCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
  confirmation: (message: string, localYes?: boolean) => Promise<void>,
): void {
  const { io, env } = runtime;
  const apiKey = program.command("api-key").description("Manage project API keys");
  apiKey
    .command("list")
    .option("--project <id>")
    .action(async (options: { project?: string }) => {
      const resolved = await settings();
      output(
        (await userClient(resolved, env).apiKeys.list(requireProject(resolved, options.project)))
          .api_keys,
      );
    });
  apiKey
    .command("create")
    .requiredOption("--name <name>")
    .option("--project <id>")
    .option("--expires-in <duration>")
    .option("--use", "store and activate the new key")
    .action(
      async (options: { name: string; project?: string; expiresIn?: string; use?: boolean }) => {
        const resolved = await settings();
        const projectId = requireProject(resolved, options.project);
        const expiresIn = options.expiresIn
          ? z.enum(["1h", "1d", "7d", "30d", "90d", "180d", "1y"]).parse(options.expiresIn)
          : undefined;
        const created = await userClient(resolved, env).apiKeys.create(projectId, {
          name: options.name,
          expires_in: expiresIn,
        });
        if (options.use) {
          await storeProjectKey(resolved.profileName, projectId, created.key, env);
          await updateProfile(resolved.profileName, { projectId }, env);
        }
        output(created);
      },
    );
  apiKey
    .command("use")
    .option("--project <id>")
    .option("--key <key>")
    .action(async (options: { project?: string; key?: string }) => {
      const resolved = await settings();
      const projectId = requireProject(resolved, options.project);
      const key =
        options.key ??
        (io.stdin.isTTY && program.opts<GlobalOptions>().input !== false
          ? await promptSecret(io, "Project API key")
          : undefined);
      if (!key) throw new Error("provide --key or set OPENMETAL_API_KEY");
      await storeProjectKey(resolved.profileName, projectId, key, env);
      await updateProfile(resolved.profileName, { projectId }, env);
      output({ profile: resolved.profileName, project_id: projectId, api_key_configured: true });
    });
  apiKey
    .command("revoke")
    .argument("<api-key-id>")
    .option("--project <id>")
    .option("-y, --yes")
    .action(async (keyId: string, options: { project?: string; yes?: boolean }) => {
      const resolved = await settings();
      const projectId = requireProject(resolved, options.project);
      await confirmation(`Revoke API key ${keyId}`, options.yes);
      output(await userClient(resolved, env).apiKeys.revoke(projectId, keyId));
    });
  apiKey
    .command("delete")
    .argument("<api-key-id>")
    .option("--project <id>")
    .option("-y, --yes")
    .action(async (keyId: string, options: { project?: string; yes?: boolean }) => {
      const resolved = await settings();
      const projectId = requireProject(resolved, options.project);
      await confirmation(`Delete API key ${keyId}`, options.yes);
      output(await userClient(resolved, env).apiKeys.delete(projectId, keyId));
    });
  apiKey
    .command("forget")
    .option("--project <id>")
    .action(async (options: { project?: string }) => {
      const resolved = await settings();
      const projectId = requireProject(resolved, options.project);
      await removeProjectKey(resolved.profileName, projectId, env);
      output({ project_id: projectId, api_key_configured: false });
    });

  const provider = program
    .command("provider-credential")
    .description("Manage organization BYOK credentials");
  provider
    .command("list")
    .option("--organization <id>")
    .action(async (options: { organization?: string }) => {
      const resolved = await settings();
      output(
        (
          await userClient(resolved, env).providerCredentials.list(
            requireOrganization(resolved, options.organization),
          )
        ).provider_credentials,
      );
    });
  provider
    .command("set")
    .requiredOption("--provider <provider>")
    .option("--organization <id>")
    .option("--file <path>")
    .option("--stdin")
    .action(
      async (options: {
        provider: string;
        organization?: string;
        file?: string;
        stdin?: boolean;
      }) => {
        const resolved = await settings();
        const parsedProvider = SandboxProviderSchema.parse(options.provider);
        const input = await parseJsonInput(
          io,
          { file: options.file, stdin: options.stdin },
          ProviderCredentialInputSchema,
        );
        if (input.provider !== parsedProvider) {
          throw new Error("provider in JSON input must match --provider");
        }
        output(
          await userClient(resolved, env).providerCredentials.configure(
            requireOrganization(resolved, options.organization),
            input,
          ),
        );
      },
    );
  provider
    .command("remove")
    .requiredOption("--provider <provider>")
    .option("--organization <id>")
    .option("-y, --yes")
    .action(async (options: { provider: string; organization?: string; yes?: boolean }) => {
      const resolved = await settings();
      const organizationId = requireOrganization(resolved, options.organization);
      const parsedProvider = SandboxProviderSchema.parse(options.provider);
      await confirmation(`Remove ${parsedProvider} credentials`, options.yes);
      output(
        await userClient(resolved, env).providerCredentials.remove(organizationId, parsedProvider),
      );
    });
}

function registerComputeCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
  confirmation: (message: string, localYes?: boolean) => Promise<void>,
): void {
  const { io } = runtime;
  const sandbox = program.command("sandbox").description("Manage sandboxes");
  sandbox
    .command("list")
    .option("--cursor <cursor>")
    .option("--limit <number>")
    .action(async (options: { cursor?: string; limit?: string }) => {
      const resolved = await settings();
      output(
        await projectClient(resolved).sandboxes.listScoped({
          cursor: options.cursor,
          limit: options.limit ? positiveInteger(options.limit, "limit") : undefined,
        }),
      );
    });
  sandbox
    .command("get")
    .argument("<sandbox-id>")
    .action(async (sandboxId: string) => {
      const resolved = await settings();
      output(await projectClient(resolved).sandboxes.get(sandboxId));
    });
  sandbox
    .command("create")
    .option("--file <path>")
    .option("--stdin")
    .option("--provider <provider>")
    .option("--environment <environment>", "portable environment name", "metal/node")
    .option("--environment-version <version>", "environment version", "latest")
    .option("--image <image>", "OCI image instead of a portable environment")
    .option("--vcpu <number>", "virtual CPUs", "1")
    .option("--memory-mb <number>", "memory in MiB", "2048")
    .option("--runtime-timeout <seconds>", "runtime timeout", "1800")
    .option("--idempotency-key <key>")
    .option("--async", "return the accepted operation immediately")
    .option("--timeout <seconds>", "wait timeout", "180")
    .action(
      async (options: {
        file?: string;
        stdin?: boolean;
        provider?: string;
        environment: string;
        environmentVersion: string;
        image?: string;
        vcpu: string;
        memoryMb: string;
        runtimeTimeout: string;
        idempotencyKey?: string;
        async?: boolean;
        timeout: string;
      }) => {
        const resolved = await settings();
        const client = projectClient(resolved);
        const request =
          options.file || options.stdin
            ? await parseJsonInput(
                io,
                { file: options.file, stdin: options.stdin },
                CreateSandboxRequestSchema,
              )
            : CreateSandboxRequestSchema.parse({
                provider: options.provider,
                source: options.image
                  ? { kind: "oci_image", image: options.image }
                  : {
                      kind: "environment",
                      environment: options.environment,
                      version: options.environmentVersion,
                    },
                resources: {
                  vcpu: positiveNumber(options.vcpu, "vcpu"),
                  memory_mb: positiveInteger(options.memoryMb, "memory-mb"),
                  architecture: "any",
                },
                lifecycle: {
                  runtime_timeout_seconds: positiveInteger(
                    options.runtimeTimeout,
                    "runtime-timeout",
                  ),
                },
              });
        const mutation = await client.sandboxes.createAsync(request, {
          idempotencyKey: options.idempotencyKey,
        });
        if (options.async || !io.stdout.isTTY) {
          output(mutation);
          return;
        }
        const operation = await client.operations.wait(mutation.operation, {
          timeoutMs: positiveInteger(options.timeout, "timeout") * 1000,
        });
        if (operation.state !== "succeeded") {
          throw new Error(operation.error?.message ?? `operation ${operation.state}`);
        }
        output(await client.sandboxes.get(mutation.sandbox.id));
      },
    );
  for (const action of ["pause", "resume"] as const) {
    sandbox
      .command(action)
      .argument("<sandbox-id>")
      .option("--async")
      .option("--timeout <seconds>", "wait timeout", "180")
      .action(async (sandboxId: string, options: { async?: boolean; timeout: string }) => {
        const resolved = await settings();
        const client = projectClient(resolved);
        const mutation =
          action === "pause"
            ? await client.sandboxes.pauseAsync(sandboxId)
            : await client.sandboxes.resumeAsync(sandboxId);
        if (options.async || !io.stdout.isTTY) {
          output(mutation);
          return;
        }
        const operation = await client.operations.wait(mutation.operation, {
          timeoutMs: positiveInteger(options.timeout, "timeout") * 1000,
        });
        if (operation.state !== "succeeded") {
          throw new Error(operation.error?.message ?? `operation ${operation.state}`);
        }
        output(await client.sandboxes.get(sandboxId));
      });
  }
  sandbox
    .command("delete")
    .alias("destroy")
    .argument("<sandbox-id>")
    .option("--async")
    .option("--timeout <seconds>", "wait timeout", "180")
    .option("-y, --yes")
    .action(
      async (sandboxId: string, options: { async?: boolean; timeout: string; yes?: boolean }) => {
        await confirmation(`Destroy sandbox ${sandboxId}`, options.yes);
        const resolved = await settings();
        const client = projectClient(resolved);
        const mutation = await client.sandboxes.deleteAsync(sandboxId);
        if (options.async || !io.stdout.isTTY) {
          output(mutation);
          return;
        }
        const operation = await client.operations.wait(mutation.operation, {
          timeoutMs: positiveInteger(options.timeout, "timeout") * 1000,
        });
        output(operation);
        requireSuccessfulOperation(operation);
      },
    );

  const operation = program.command("operation").description("Inspect asynchronous operations");
  operation
    .command("get")
    .argument("<operation-id>")
    .action(async (operationId: string) => {
      const resolved = await settings();
      output(await projectClient(resolved).operations.get(operationId));
    });
  operation
    .command("wait")
    .argument("<operation-id>")
    .option("--timeout <seconds>", "wait timeout", "180")
    .action(async (operationId: string, options: { timeout: string }) => {
      const resolved = await settings();
      const result = await projectClient(resolved).operations.wait(operationId, {
        timeoutMs: positiveInteger(options.timeout, "timeout") * 1000,
      });
      output(result);
      requireSuccessfulOperation(result);
    });
  operation
    .command("events")
    .argument("<operation-id>")
    .option("--after <sequence>", "last received event sequence", "0")
    .action(async (operationId: string, options: { after: string }) => {
      const resolved = await settings();
      output(
        await projectClient(resolved).operations.events(operationId, {
          lastEventId: nonnegativeInteger(options.after, "after"),
        }),
      );
    });
  operation
    .command("watch")
    .argument("<operation-id>")
    .option("--timeout <seconds>", "watch timeout", "180")
    .action(async (operationId: string, options: { timeout: string }) => {
      const resolved = await settings();
      const client = projectClient(resolved);
      const deadline = Date.now() + positiveInteger(options.timeout, "timeout") * 1000;
      const structuredOutput = Boolean(program.opts<GlobalOptions>().json || !io.stdout.isTTY);
      const collectedEvents: OperationEvent[] = [];
      let lastEventId = 0;
      while (Date.now() < deadline) {
        const eventBatch = await client.operations.events(operationId, { lastEventId });
        for (const event of eventBatch) {
          if (structuredOutput) {
            collectedEvents.push(event);
          } else {
            writeText(io, `${event.sequence}\t${event.type}\t${event.occurred_at}`);
          }
          lastEventId = event.sequence;
        }
        const current = await client.operations.get(operationId);
        if (TERMINAL_OPERATION_STATES.has(current.state)) {
          if (structuredOutput) {
            output({ events: collectedEvents, operation: current });
          } else {
            writeText(io, `${current.state}\t${current.updated_at}`);
          }
          requireSuccessfulOperation(current);
          return;
        }
        await sleep(500);
      }
      if (structuredOutput) output({ events: collectedEvents, operation: null });
      throw new Error(`operation ${operationId} did not complete before timeout`);
    });

  const events = program.command("events").description("Inspect durable project events");
  events
    .command("list")
    .option("--project <id>")
    .option("--after <cursor>")
    .option("--limit <number>")
    .action(async (options: { project?: string; after?: string; limit?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, runtime.env).events.list({
          projectId: requireProject(resolved, options.project),
          after: options.after,
          limit: options.limit ? positiveInteger(options.limit, "limit") : undefined,
        }),
      );
    });
}

function registerTeamCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
  confirmation: (message: string, localYes?: boolean) => Promise<void>,
): void {
  const { env } = runtime;
  const member = program.command("member").description("Manage organization members");
  member
    .command("list")
    .option("--organization <id>")
    .action(async (options: { organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).members.list(
          requireOrganization(resolved, options.organization),
        ),
      );
    });
  member
    .command("update")
    .argument("<user-id>")
    .requiredOption("--role <role>")
    .option("--organization <id>")
    .action(async (userId: string, options: { role: string; organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).members.update(
          requireOrganization(resolved, options.organization),
          userId,
          { role: role(options.role) },
        ),
      );
    });
  member
    .command("remove")
    .argument("<user-id>")
    .option("--organization <id>")
    .option("-y, --yes")
    .action(async (userId: string, options: { organization?: string; yes?: boolean }) => {
      const resolved = await settings();
      await confirmation(`Remove organization member ${userId}`, options.yes);
      output(
        await userClient(resolved, env).members.remove(
          requireOrganization(resolved, options.organization),
          userId,
        ),
      );
    });

  const invitation = program.command("invitation").description("Manage organization invitations");
  invitation
    .command("create")
    .requiredOption("--email <email>")
    .option("--role <role>", "admin or member", "member")
    .option("--organization <id>")
    .action(async (options: { email: string; role: string; organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).invitations.create(
          requireOrganization(resolved, options.organization),
          { email: z.string().email().parse(options.email), role: role(options.role) },
        ),
      );
    });
  invitation
    .command("update")
    .argument("<invitation-id>")
    .requiredOption("--role <role>")
    .option("--organization <id>")
    .action(async (invitationId: string, options: { role: string; organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).invitations.update(
          requireOrganization(resolved, options.organization),
          invitationId,
          { role: role(options.role) },
        ),
      );
    });
  invitation
    .command("resend")
    .argument("<invitation-id>")
    .option("--organization <id>")
    .action(async (invitationId: string, options: { organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).invitations.resend(
          requireOrganization(resolved, options.organization),
          invitationId,
        ),
      );
    });
  invitation
    .command("revoke")
    .argument("<invitation-id>")
    .option("--organization <id>")
    .option("-y, --yes")
    .action(async (invitationId: string, options: { organization?: string; yes?: boolean }) => {
      const resolved = await settings();
      await confirmation(`Revoke invitation ${invitationId}`, options.yes);
      output(
        await userClient(resolved, env).invitations.revoke(
          requireOrganization(resolved, options.organization),
          invitationId,
        ),
      );
    });
}

function registerBillingCommands(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
): void {
  const { env } = runtime;
  const billing = program.command("billing").description("Manage organization billing");
  billing
    .command("show")
    .option("--organization <id>")
    .action(async (options: { organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).billing.get(
          requireOrganization(resolved, options.organization),
        ),
      );
    });
  billing
    .command("quote")
    .requiredOption("--amount-usd <amount>")
    .option("--organization <id>")
    .action(async (options: { amountUsd: string; organization?: string }) => {
      const resolved = await settings();
      output(
        await userClient(resolved, env).billing.quote(
          requireOrganization(resolved, options.organization),
          options.amountUsd,
        ),
      );
    });
  billing
    .command("checkout")
    .requiredOption("--amount-usd <amount>")
    .option("--organization <id>")
    .option("--idempotency-key <key>")
    .option("--open", "open the checkout URL")
    .action(
      async (options: {
        amountUsd: string;
        organization?: string;
        idempotencyKey?: string;
        open?: boolean;
      }) => {
        const resolved = await settings();
        const result = await userClient(resolved, env).billing.checkout(
          requireOrganization(resolved, options.organization),
          { amount_usd: options.amountUsd },
          { idempotencyKey: options.idempotencyKey },
        );
        output(result);
        if (options.open) await openExternalUrl(result.checkout_url);
      },
    );
  billing
    .command("payment-method")
    .option("--organization <id>")
    .option("--open", "open the setup URL")
    .action(async (options: { organization?: string; open?: boolean }) => {
      const resolved = await settings();
      const result = await userClient(resolved, env).billing.setupPaymentMethod(
        requireOrganization(resolved, options.organization),
      );
      output(result);
      if (options.open) await openExternalUrl(result.checkout_url);
    });
  billing
    .command("auto-topup")
    .requiredOption("--enabled <boolean>")
    .requiredOption("--threshold-usd <amount>")
    .requiredOption("--refill-usd <amount>")
    .requiredOption("--monthly-cap-usd <amount>")
    .option("--organization <id>")
    .action(
      async (options: {
        enabled: string;
        thresholdUsd: string;
        refillUsd: string;
        monthlyCapUsd: string;
        organization?: string;
      }) => {
        const resolved = await settings();
        output(
          await userClient(resolved, env).billing.updateAutoTopup(
            requireOrganization(resolved, options.organization),
            {
              enabled: booleanValue(options.enabled),
              threshold_usd: options.thresholdUsd,
              refill_usd: options.refillUsd,
              monthly_cap_usd: options.monthlyCapUsd,
            },
          ),
        );
      },
    );
}

function registerSetupCommand(
  program: Command,
  runtime: CliRuntime,
  settings: () => Promise<ResolvedSettings>,
  output: (value: unknown) => void,
): void {
  const { io, env } = runtime;
  program
    .command("setup")
    .description("Interactively configure login, organization, project, and API key")
    .option("--provider <provider>", "OAuth provider", "github")
    .option("--organization <id>")
    .option("--project <id>")
    .option("--key-name <name>", "new API key name", "OpenMetal CLI")
    .option("--no-browser")
    .action(
      async (options: {
        provider: string;
        organization?: string;
        project?: string;
        keyName: string;
        browser: boolean;
      }) => {
        if (program.opts<GlobalOptions>().input === false) {
          throw new Error("setup is interactive; use individual commands with --no-input");
        }
        let resolved = await settings();
        const status = await authStatus(resolved, env);
        if (!status.authenticated) {
          await login(
            resolved,
            io,
            {
              provider: z.enum(["github", "google"]).parse(options.provider),
              openBrowser: options.browser,
            },
            env,
          );
          resolved = await settings();
        }
        const client = userClient(resolved, env);
        const organizations = (await client.organizations.list()).organizations;
        let organizationId = options.organization ?? resolved.organizationId;
        if (!organizationId) {
          if (organizations.length > 0) {
            organizationId = (
              await choose(
                io,
                "Choose an organization",
                organizations,
                (item) => `${item.name} (${item.id})`,
              )
            ).id;
          } else {
            const name = await promptLine(io, "Organization name");
            const slug = await promptLine(io, "Organization slug");
            organizationId = (await client.organizations.create({ name, slug })).id;
          }
        }
        let projectId = options.project ?? resolved.projectId;
        if (!projectId) {
          const projects = (await client.projects.list(organizationId)).projects;
          if (projects.length > 0) {
            projectId = (
              await choose(io, "Choose a project", projects, (item) => `${item.name} (${item.id})`)
            ).id;
          } else {
            const name = await promptLine(io, "Project name");
            const suggested = slugify(name);
            const slug = (await promptLine(io, `Project slug [${suggested}]`)) || suggested;
            projectId = (await client.projects.create(organizationId, { name, slug })).id;
          }
        }
        await confirm(io, `Create and store a 90-day API key for project ${projectId}`, {
          yes: program.opts<GlobalOptions>().yes,
        });
        const created = await client.apiKeys.create(projectId, {
          name: options.keyName,
          expires_in: "90d",
        });
        await storeProjectKey(resolved.profileName, projectId, created.key, env);
        await updateProfile(resolved.profileName, { organizationId, projectId }, env);
        output({
          profile: resolved.profileName,
          organization_id: organizationId,
          project_id: projectId,
          api_key: created.key,
          expires_at: created.api_key.expires_at,
        });
      },
    );
}

function requireOrganization(settings: ResolvedSettings, value?: string): string {
  const id = value ?? settings.organizationId;
  if (!id) {
    throw new Error(
      "organization is not selected; pass --organization or run `openmetal context use`",
    );
  }
  return id;
}

function requireProject(settings: ResolvedSettings, value?: string): string {
  const id = value ?? settings.projectId;
  if (!id) {
    throw new Error("project is not selected; pass --project or run `openmetal project use`");
  }
  return id;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function requireSuccessfulOperation(operation: Operation): void {
  if (operation.state === "succeeded") return;
  const message =
    operation.error?.message ?? `operation ${operation.id} ended in state ${operation.state}`;
  throw new Error(message);
}

function booleanValue(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("boolean value must be true or false");
}

function role(value: string): InvitationRole {
  return z.enum(["admin", "member"]).parse(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function completionScript(shell: string): string {
  const commands =
    "auth config context setup org project api-key provider-credential sandbox process file endpoint operation events member invitation billing doctor health ready meta version completion";
  switch (shell) {
    case "bash":
      return `_openmetal() { COMPREPLY=( $(compgen -W "${commands}" -- "\${COMP_WORDS[1]}") ); }\ncomplete -F _openmetal openmetal`;
    case "zsh":
      return `#compdef openmetal\n_arguments '1:command:(${commands})'`;
    case "fish":
      return commands
        .split(" ")
        .map((command) => `complete -c openmetal -n '__fish_use_subcommand' -a ${command}`)
        .join("\n");
    case "powershell":
      return `Register-ArgumentCompleter -Native -CommandName openmetal -ScriptBlock { param($wordToComplete) '${commands}'.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } }`;
    default:
      throw new Error("shell must be bash, zsh, fish, or powershell");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
