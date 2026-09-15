import type { Metadata } from "next";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import {
  getPreferredOrganization,
  listDashboardOrganizations,
} from "@/lib/dashboard-organizations";
import { dashboardPageMetadata } from "@/lib/page-metadata";
import { requireMetalSession } from "@/lib/metal-server";
import { resolveDisplayName } from "@/lib/user-profile";

export const metadata: Metadata = dashboardPageMetadata({
  title: "Dashboard",
  description: "Manage organizations, projects, sandboxes, billing, and API keys.",
  path: "/dashboard",
});

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [{ claims }, organizations] = await Promise.all([
    requireMetalSession(),
    listDashboardOrganizations(),
  ]);
  const email = typeof claims.email === "string" ? claims.email : "account@openmetal.sh";
  const metadata =
    claims.user_metadata &&
    typeof claims.user_metadata === "object" &&
    !Array.isArray(claims.user_metadata)
      ? (claims.user_metadata as Record<string, unknown>)
      : undefined;
  const preferredOrganization = await getPreferredOrganization(organizations);

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <AppSidebar
        user={{ name: resolveDisplayName(email, metadata), email }}
        organizations={organizations}
        preferredOrganizationId={preferredOrganization?.id}
      />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SiteHeader
          organizations={organizations}
          preferredOrganizationId={preferredOrganization?.id}
        />
        <ScrollArea className="min-h-0 w-full flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 pt-12">{children}</div>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  );
}
