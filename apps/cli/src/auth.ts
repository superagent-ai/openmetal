import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { createClient, type Session } from "@supabase/supabase-js";
import {
  clearSession,
  getStoredSession,
  storeSession,
  type ResolvedSettings,
  type RuntimeEnvironment,
  type StoredSession,
} from "./config.js";
import type { CliIo } from "./io.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 54_389;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

type OAuthProvider = "github" | "google";

export async function login(
  settings: ResolvedSettings,
  io: CliIo,
  options: {
    provider: OAuthProvider;
    openBrowser: boolean;
    timeoutMs?: number;
  },
  env: RuntimeEnvironment = process.env,
): Promise<StoredSession> {
  const { supabaseUrl, supabasePublishableKey } = requireSupabaseSettings(settings);
  const state = crypto.randomUUID();
  const redirectTo = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback?state=${encodeURIComponent(state)}`;
  const storage = new MapStorage();
  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      flowType: "pkce",
      storage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const callback = await startLoginCallback(state, options.timeoutMs ?? LOGIN_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: options.provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data.url)
      throw new Error(error?.message ?? "authentication URL was not returned");

    io.stdout.write(`Open this URL to sign in:\n${data.url}\n`);
    if (options.openBrowser) {
      try {
        await openExternalUrl(data.url);
      } catch {
        io.stderr.write("Could not open a browser automatically; use the URL above.\n");
      }
    }

    const code = await callback.code;
    const { data: exchanged, error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError || !exchanged.session) {
      throw new Error(exchangeError?.message ?? "authentication session was not returned");
    }
    const session = serializeSession(exchanged.session);
    await storeSession(settings.profileName, session, env);
    return session;
  } finally {
    await closeServer(callback.server);
  }
}

export async function logout(
  profileName: string,
  env: RuntimeEnvironment = process.env,
): Promise<void> {
  await clearSession(profileName, env);
}

export async function accessTokenForUser(
  settings: ResolvedSettings,
  env: RuntimeEnvironment = process.env,
): Promise<string> {
  const stored = await getStoredSession(settings.profileName, env);
  if (settings.accessToken && settings.accessToken !== stored?.accessToken) {
    return settings.accessToken;
  }
  if (!stored) throw new Error("not logged in; run `openmetal auth login`");
  if (!stored.expiresAt || stored.expiresAt > Math.floor(Date.now() / 1000) + 60) {
    return stored.accessToken;
  }

  const { supabaseUrl, supabasePublishableKey } = requireSupabaseSettings(settings);
  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: stored.refreshToken,
  });
  if (error || !data.session) {
    throw new Error(`session refresh failed: ${error?.message ?? "no session returned"}`);
  }
  const refreshed = serializeSession(data.session);
  await storeSession(settings.profileName, refreshed, env);
  return refreshed.accessToken;
}

export async function authStatus(
  settings: ResolvedSettings,
  env: RuntimeEnvironment = process.env,
): Promise<Record<string, unknown>> {
  const session = await getStoredSession(settings.profileName, env);
  if (
    settings.accessToken &&
    settings.accessToken !== env.OPENMETAL_ACCESS_TOKEN &&
    settings.accessToken !== session?.accessToken
  ) {
    return { authenticated: true, source: "flag", profile: settings.profileName };
  }
  if (env.OPENMETAL_ACCESS_TOKEN) {
    return { authenticated: true, source: "environment", profile: settings.profileName };
  }
  if (!session) {
    return { authenticated: false, source: null, profile: settings.profileName };
  }
  return {
    authenticated: true,
    source: "credentials",
    profile: settings.profileName,
    user_id: session.user?.id,
    email: session.user?.email,
    expires_at: session.expiresAt ? new Date(session.expiresAt * 1000).toISOString() : undefined,
  };
}

function requireSupabaseSettings(settings: ResolvedSettings): {
  supabaseUrl: string;
  supabasePublishableKey: string;
} {
  if (!settings.supabaseUrl || !settings.supabasePublishableKey) {
    throw new Error(
      "Supabase auth is not configured; set OPENMETAL_SUPABASE_URL and OPENMETAL_SUPABASE_PUBLISHABLE_KEY",
    );
  }
  return {
    supabaseUrl: settings.supabaseUrl,
    supabasePublishableKey: settings.supabasePublishableKey,
  };
}

function serializeSession(session: Session): StoredSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    user: {
      id: session.user.id,
      email: session.user.email,
    },
  };
}

export async function startLoginCallback(
  expectedState: string,
  timeoutMs: number,
  port = CALLBACK_PORT,
): Promise<{ server: Server; code: Promise<string> }> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const timeout: { timer?: ReturnType<typeof setTimeout> } = {};
  let settled = false;
  const settle = (result: { code?: string; error?: Error }) => {
    if (settled) return;
    settled = true;
    if (timeout.timer) clearTimeout(timeout.timer);
    if (result.error) rejectCode(result.error);
    else if (result.code) resolveCode(result.code);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}:${port}`);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const authCode = url.searchParams.get("code");
    if (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(error);
      settle({ error: new Error(error) });
      return;
    }
    if (state !== expectedState || !authCode) {
      response
        .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("Invalid authentication callback.");
      settle({ error: new Error("invalid authentication callback") });
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>OpenMetal login</title><p>Login complete. You can close this window.</p>",
      );
    settle({ code: authCode });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, CALLBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  timeout.timer = setTimeout(() => settle({ error: new Error("login timed out") }), timeoutMs);
  server.once("error", (error) => settle({ error }));
  return { server, code };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function openExternalUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/d", "/s", "/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

class MapStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
