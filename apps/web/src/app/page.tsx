import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const href = data?.claims ? "/dashboard" : "/login";
  const label = data?.claims ? "Open dashboard" : "Sign in with email";

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-16">
      <p className="text-sm text-[#9b9b9b]">Superagent Metal</p>
      <h1 className="mt-4 max-w-[680px] bg-linear-to-r from-white to-[#9B9B9B] bg-clip-text text-5xl font-semibold tracking-tight text-transparent">
        Give your agent a computer from one control plane.
      </h1>
      <p className="mt-6 max-w-[680px] text-lg text-[#9b9b9b]">
        This first milestone is the product control plane. Create an organization, add a project,
        and recover durable events after a disconnect.
      </p>
      <Link
        href={href}
        className="mt-8 inline-flex w-fit rounded-lg bg-white px-3 py-2 text-base font-semibold text-black hover:translate-y-px"
      >
        {label}
      </Link>
    </main>
  );
}
