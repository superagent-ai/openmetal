import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-black">
      <header className="border border-[#272727] bg-[#181818]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-8 py-4">
          <p className="text-sm font-semibold">Metal</p>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/dashboard" className="text-[#9b9b9b] hover:text-white">
              Overview
            </Link>
            <Link href="/dashboard/projects" className="text-[#9b9b9b] hover:text-white">
              Projects
            </Link>
            <Link href="/dashboard/settings" className="text-[#9b9b9b] hover:text-white">
              Settings
            </Link>
            <form action="/auth/logout" method="post">
              <button type="submit" className="text-sm font-semibold">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
    </div>
  );
}
