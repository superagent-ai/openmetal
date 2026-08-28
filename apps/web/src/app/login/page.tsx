import Link from "next/link";
import { LoginForm } from "@/components/login-form";
import { LoginRouteDiagram } from "@/components/login-route-diagram";
import { OpenMetalLogo } from "@/components/openmetal-logo";
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
          <Link href="/" aria-label="OpenMetal documentation">
            <OpenMetalLogo />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            <LoginForm sent={params.sent} error={params.error} next={nextValue} />
          </div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-muted lg:block">
        <div className="absolute inset-0 flex items-center justify-center p-16">
          <div className="aspect-video w-full max-w-3xl">
            <LoginRouteDiagram />
          </div>
        </div>
        <div className="relative flex h-full flex-col items-center justify-end px-10 pt-10 pb-16 text-center">
          <div className="flex w-full max-w-xl flex-col items-center">
            <p className="bg-gradient-to-r from-[#000000] to-[#666666] bg-clip-text text-3xl font-semibold text-balance text-transparent dark:from-white dark:to-[#9B9B9B]">
              Give your agent access to Metal.
            </p>
            <p className="mt-4 max-w-lg text-sm text-pretty text-muted-foreground">
              One API for agent compute across providers, from sandboxes and CPUs to GPUs and
              persistent machines.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
