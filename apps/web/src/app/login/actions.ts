"use server";

import { redirect } from "next/navigation";
import {
  DEFAULT_POST_AUTH_PATH,
  loginErrorPath,
  postAuthPath,
  siteOrigin,
  withNextParam,
} from "@/lib/auth-redirect";
import { createClient } from "@/lib/supabase/server";

const OAUTH_PROVIDERS = ["google", "github"] as const;

type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

function isOAuthProvider(value: string): value is OAuthProvider {
  return OAUTH_PROVIDERS.includes(value as OAuthProvider);
}

function formNextPath(formData: FormData): string {
  return postAuthPath(String(formData.get("next") ?? ""));
}

export async function sendMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const next = formNextPath(formData);
  if (!email) {
    redirect(loginErrorPath("Enter an email address", next));
  }

  const supabase = await createClient();
  const origin = siteOrigin();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: withNextParam("/auth/confirm", origin, next),
      shouldCreateUser: true,
    },
  });

  if (error) {
    redirect(loginErrorPath(error.message, next));
  }

  const params = new URLSearchParams({ sent: "1" });
  if (next !== DEFAULT_POST_AUTH_PATH) {
    params.set("next", next);
  }
  redirect(`/login?${params.toString()}`);
}

export async function signInWithOAuth(formData: FormData) {
  const provider = String(formData.get("provider") ?? "");
  const next = formNextPath(formData);
  if (!isOAuthProvider(provider)) {
    redirect(loginErrorPath("Unsupported sign in method", next));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: withNextParam("/auth/callback", siteOrigin(), next),
    },
  });

  if (error || !data.url) {
    redirect(loginErrorPath(error?.message ?? "Sign in failed", next));
  }

  redirect(data.url);
}
