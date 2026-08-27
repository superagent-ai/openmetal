import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

declare const __OPENMETAL_DEFAULT_API_URL__: string;
declare const __OPENMETAL_DEFAULT_SUPABASE_URL__: string;
declare const __OPENMETAL_DEFAULT_SUPABASE_KEY__: string;

const ProfileSchema = z.object({
  apiUrl: z.string().url().optional(),
  supabaseUrl: z.string().url().optional(),
  supabasePublishableKey: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  activeProfile: z.string().min(1).default("default"),
  profiles: z.record(z.string(), ProfileSchema).default({}),
});

const SessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int().positive().optional(),
  user: z
    .object({
      id: z.string().min(1),
      email: z.string().optional(),
    })
    .optional(),
});

const CredentialProfileSchema = z.object({
  session: SessionSchema.optional(),
  projectKeys: z.record(z.string(), z.string().startsWith("metal_sk_")).default({}),
});

const CredentialsSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), CredentialProfileSchema).default({}),
});
const execFileAsync = promisify(execFile);

export type Profile = z.infer<typeof ProfileSchema>;
export type StoredSession = z.infer<typeof SessionSchema>;
export type OpenMetalConfig = z.infer<typeof ConfigSchema>;
export type OpenMetalCredentials = z.infer<typeof CredentialsSchema>;

export type RuntimeEnvironment = Record<string, string | undefined>;

export type ResolvedSettings = {
  profileName: string;
  apiUrl: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  organizationId?: string;
  projectId?: string;
  accessToken?: string;
  apiKey?: string;
};

export type GlobalOverrides = {
  profile?: string;
  apiUrl?: string;
  organizationId?: string;
  projectId?: string;
  accessToken?: string;
  apiKey?: string;
};

export function configDirectory(env: RuntimeEnvironment = process.env): string {
  if (env.OPENMETAL_CONFIG_HOME) return env.OPENMETAL_CONFIG_HOME;
  if (process.platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "openmetal");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "openmetal");
}

export function configPath(env: RuntimeEnvironment = process.env): string {
  return join(configDirectory(env), "config.json");
}

export function credentialsPath(env: RuntimeEnvironment = process.env): string {
  return join(configDirectory(env), "credentials.json");
}

export async function loadConfig(env: RuntimeEnvironment = process.env): Promise<OpenMetalConfig> {
  return readJson(configPath(env), ConfigSchema, {
    version: 1,
    activeProfile: "default",
    profiles: {},
  });
}

export async function loadCredentials(
  env: RuntimeEnvironment = process.env,
): Promise<OpenMetalCredentials> {
  return readJson(credentialsPath(env), CredentialsSchema, { version: 1, profiles: {} });
}

export async function saveConfig(
  config: OpenMetalConfig,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  await writePrivateJson(configPath(env), ConfigSchema.parse(config));
}

export async function saveCredentials(
  credentials: OpenMetalCredentials,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  await writePrivateJson(credentialsPath(env), CredentialsSchema.parse(credentials));
}

export async function resolveSettings(
  overrides: GlobalOverrides = {},
  env: RuntimeEnvironment = process.env,
): Promise<ResolvedSettings> {
  const [config, credentials] = await Promise.all([loadConfig(env), loadCredentials(env)]);
  const profileName = overrides.profile ?? env.OPENMETAL_PROFILE ?? config.activeProfile;
  const profile = config.profiles[profileName] ?? {};
  const credentialProfile = credentials.profiles[profileName];
  const projectId =
    overrides.projectId ??
    env.OPENMETAL_PROJECT_ID ??
    env.METAL_PROJECT_ID ??
    profile.projectId ??
    undefined;

  return {
    profileName,
    apiUrl: stripTrailingSlash(
      overrides.apiUrl ??
        env.OPENMETAL_API_URL ??
        env.METAL_API_URL ??
        profile.apiUrl ??
        defaultApiUrl(),
    ),
    supabaseUrl:
      env.OPENMETAL_SUPABASE_URL ?? profile.supabaseUrl ?? defaultSupabaseUrl() ?? undefined,
    supabasePublishableKey:
      env.OPENMETAL_SUPABASE_PUBLISHABLE_KEY ??
      profile.supabasePublishableKey ??
      defaultSupabaseKey() ??
      undefined,
    organizationId:
      overrides.organizationId ??
      env.OPENMETAL_ORGANIZATION_ID ??
      profile.organizationId ??
      undefined,
    projectId,
    accessToken:
      overrides.accessToken ??
      env.OPENMETAL_ACCESS_TOKEN ??
      credentialProfile?.session?.accessToken ??
      undefined,
    apiKey:
      overrides.apiKey ??
      env.OPENMETAL_API_KEY ??
      env.METAL_API_KEY ??
      (projectId ? credentialProfile?.projectKeys[projectId] : undefined),
  };
}

export async function updateProfile(
  profileName: string,
  patch: Partial<Profile>,
  env: RuntimeEnvironment = process.env,
): Promise<Profile> {
  const config = await loadConfig(env);
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const profile = ProfileSchema.parse({
    ...(config.profiles[profileName] ?? {}),
    ...definedPatch,
  });
  config.profiles[profileName] = profile;
  await saveConfig(config, env);
  return profile;
}

export async function setActiveProfile(
  profileName: string,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  const config = await loadConfig(env);
  config.activeProfile = profileName;
  config.profiles[profileName] ??= {};
  await saveConfig(config, env);
}

export async function storeSession(
  profileName: string,
  session: StoredSession,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  const credentials = await loadCredentials(env);
  const profile = credentials.profiles[profileName] ?? { projectKeys: {} };
  profile.session = SessionSchema.parse(session);
  credentials.profiles[profileName] = profile;
  await saveCredentials(credentials, env);
}

export async function clearSession(
  profileName: string,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  const credentials = await loadCredentials(env);
  const profile = credentials.profiles[profileName];
  if (profile) {
    delete profile.session;
    credentials.profiles[profileName] = profile;
    await saveCredentials(credentials, env);
  }
}

export async function getStoredSession(
  profileName: string,
  env: RuntimeEnvironment = process.env,
): Promise<StoredSession | undefined> {
  return (await loadCredentials(env)).profiles[profileName]?.session;
}

export async function storeProjectKey(
  profileName: string,
  projectId: string,
  key: string,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  const credentials = await loadCredentials(env);
  const profile = credentials.profiles[profileName] ?? { projectKeys: {} };
  profile.projectKeys[projectId] = z.string().startsWith("metal_sk_").parse(key);
  credentials.profiles[profileName] = profile;
  await saveCredentials(credentials, env);
}

export async function removeProjectKey(
  profileName: string,
  projectId: string,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  const credentials = await loadCredentials(env);
  const profile = credentials.profiles[profileName];
  if (profile?.projectKeys[projectId]) {
    delete profile.projectKeys[projectId];
    credentials.profiles[profileName] = profile;
    await saveCredentials(credentials, env);
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return fallback;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error(`invalid OpenMetal configuration at ${path}: ${error.message}`);
    }
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    if (process.platform === "win32") {
      const username = process.env.USERNAME;
      if (!username) throw new Error("cannot restrict credential file without USERNAME");
      const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
      await execFileAsync("icacls", [temporary, "/inheritance:r", "/grant:r", `${account}:(F)`]);
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultApiUrl(): string {
  return typeof __OPENMETAL_DEFAULT_API_URL__ === "string"
    ? __OPENMETAL_DEFAULT_API_URL__
    : "http://127.0.0.1:4000";
}

function defaultSupabaseUrl(): string | undefined {
  return typeof __OPENMETAL_DEFAULT_SUPABASE_URL__ === "string" &&
    __OPENMETAL_DEFAULT_SUPABASE_URL__.length > 0
    ? __OPENMETAL_DEFAULT_SUPABASE_URL__
    : undefined;
}

function defaultSupabaseKey(): string | undefined {
  return typeof __OPENMETAL_DEFAULT_SUPABASE_KEY__ === "string" &&
    __OPENMETAL_DEFAULT_SUPABASE_KEY__.length > 0
    ? __OPENMETAL_DEFAULT_SUPABASE_KEY__
    : undefined;
}
