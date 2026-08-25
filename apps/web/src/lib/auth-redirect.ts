import { safeInternalPath } from "./safe-redirect";

export const DEFAULT_POST_AUTH_PATH = "/dashboard";

export function siteOrigin(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100";
}

export function postAuthPath(value: string | null | undefined): string {
  return safeInternalPath(value, DEFAULT_POST_AUTH_PATH);
}

export function loginErrorPath(message: string, next?: string): string {
  const trimmed = message.trim() || "Sign in failed";
  const params = new URLSearchParams({ error: trimmed });
  if (next && next !== DEFAULT_POST_AUTH_PATH) {
    params.set("next", next);
  }
  return `/login?${params.toString()}`;
}

export function withNextParam(
  pathname: "/auth/callback" | "/auth/confirm",
  origin: string,
  next: string,
): string {
  const url = new URL(pathname, origin);
  url.searchParams.set("next", next);
  return url.toString();
}
