import Link from "next/link";
import { HexagonIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LoginForm } from "@/components/login-form";
import { LoginRouteDiagram } from "@/components/login-route-diagram";
import { DEFAULT_POST_AUTH_PATH, postAuthPath } from "@/lib/auth-redirect";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = postAuthPath(params.next);
  const nextValue = next === DEFAULT_POST_AUTH_PATH ? undefined : next;

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <Link href="/" className="flex items-center gap-2 font-medium">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <HugeiconsIcon icon={HexagonIcon} strokeWidth={2} className="size-4" />
            </div>
            Metal
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            <LoginForm sent={params.sent} error={params.error} next={nextValue} />
          </div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-muted lg:block">
        <div className="absolute inset-10 bottom-24">
          <LoginRouteDiagram />
        </div>
        <div className="relative flex h-full flex-col justify-end p-10">
          <p className="max-w-md bg-gradient-to-r from-[#000000] to-[#666666] bg-clip-text text-3xl font-semibold text-balance text-transparent dark:from-white dark:to-[#9B9B9B]">
            Give your agent a computer from one control plane.
          </p>
          <p className="mt-4 max-w-md text-sm text-pretty text-muted-foreground">
            Run agents across every sandbox provider with one API, automatic routing, and durable
            lifecycle events.
          </p>
        </div>
      </div>
    </div>
  );
}
