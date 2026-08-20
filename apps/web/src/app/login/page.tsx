import Link from "next/link";
import { HexagonIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LoginForm } from "@/components/login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const params = await searchParams;

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
          <div className="w-full max-w-xs">
            <LoginForm sent={params.sent} error={params.error} />
          </div>
        </div>
      </div>
      <div className="relative hidden bg-muted lg:block">
        <div className="absolute inset-0 bg-[#181818]" />
        <div className="relative flex h-full flex-col justify-end p-10">
          <p className="max-w-md text-3xl font-semibold text-balance">
            Give your agent a computer from one control plane.
          </p>
          <p className="mt-4 max-w-md text-sm text-pretty text-muted-foreground">
            Create an organization, add a project, and recover durable events after a disconnect.
          </p>
        </div>
      </div>
    </div>
  );
}
