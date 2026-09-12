import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { DEFAULT_POST_AUTH_PATH, postAuthPath } from "@/lib/auth-redirect";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  title: "Sign in",
  description: "Continue with Google or GitHub, or email a magic link to access OpenMetal.",
  path: "/login",
  image: false,
});

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = postAuthPath(params.next);
  const nextValue = next === DEFAULT_POST_AUTH_PATH ? undefined : next;

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <LoginForm sent={params.sent} error={params.error} next={nextValue} />
      </div>
    </main>
  );
}
