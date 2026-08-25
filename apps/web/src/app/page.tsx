import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const href = data?.claims ? "/dashboard" : "/login";
  const label = data?.claims ? "Open dashboard" : "Sign in";

  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col justify-center px-8 py-16">
      <p className="text-sm text-muted-foreground">Superagent Metal</p>
      <h1 className="mt-4 max-w-[680px] bg-linear-to-r from-white to-[#9B9B9B] bg-clip-text text-5xl font-semibold tracking-tight text-transparent">
        Give your agent a computer from one control plane.
      </h1>
      <p className="mt-6 max-w-[680px] text-lg text-pretty text-muted-foreground">
        This first milestone is the product control plane. Create an organization, add a project,
        and recover durable events after a disconnect.
      </p>
      <Button
        nativeButton={false}
        render={<Link href={href} />}
        size="lg"
        className="mt-8 w-fit text-base"
      >
        {label}
      </Button>
    </main>
  );
}
