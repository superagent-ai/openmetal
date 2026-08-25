import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errors.js";
import type { ApiEnv } from "./env.js";

export type Principal = {
  userId: string;
  role: string;
};

export function createAuthVerifier(env: ApiEnv): {
  client: SupabaseClient;
  verify: (token: string | undefined) => Promise<Principal>;
} {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    client,
    async verify(token) {
      if (!token) {
        throw new ApiError(401, "unauthenticated", "missing bearer token");
      }
      const { data, error } = await client.auth.getClaims(token);
      if (error || !data?.claims) {
        throw new ApiError(401, "unauthenticated", "invalid or expired token");
      }
      const sub = data.claims.sub;
      if (typeof sub !== "string" || sub.length === 0) {
        throw new ApiError(401, "unauthenticated", "token is missing sub");
      }
      const role = typeof data.claims.role === "string" ? data.claims.role : "authenticated";
      return { userId: sub, role };
    },
  };
}

export function createAuthAdmin(env: ApiEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
