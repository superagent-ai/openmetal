import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { loadTestEnv, type TestEnv } from "./env.js";

export type TestUser = {
  user: User;
  email: string;
  password: string;
  accessToken: string;
};

export function createAdminClient(env: TestEnv = loadTestEnv()): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createUserClient(
  accessToken: string,
  env: TestEnv = loadTestEnv(),
): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

export async function createConfirmedUser(
  env: TestEnv = loadTestEnv(),
  input?: { email?: string; password?: string },
): Promise<TestUser> {
  const admin = createAdminClient(env);
  const email = input?.email ?? `metal-${crypto.randomUUID()}@example.test`;
  const password = input?.password ?? `Passw0rd-${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("failed to create user");
  }
  const session = await admin.auth.signInWithPassword({ email, password });
  if (session.error || !session.data.session) {
    throw session.error ?? new Error("failed to sign in test user");
  }
  return {
    user: created.data.user,
    email,
    password,
    accessToken: session.data.session.access_token,
  };
}

export async function deleteUser(userId: string, env: TestEnv = loadTestEnv()): Promise<void> {
  const admin = createAdminClient(env);
  await admin.auth.admin.deleteUser(userId);
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const intervalMs = options?.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}
