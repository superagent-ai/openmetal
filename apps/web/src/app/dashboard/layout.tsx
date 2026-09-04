import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getCurrentUser } from "@/lib/current-user";
import { getPreferredOrganization } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { resolveDisplayName } from "@/lib/user-profile";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [{ metal }, user] = await Promise.all([requireMetalSession(), getCurrentUser()]);
  const email = user.email ?? "account@metal";
  const { organizations } = await metal.organizations.list();
  const preferredOrganization = await getPreferredOrganization(organizations);

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <AppSidebar
        user={{ name: resolveDisplayName(email, user.user_metadata), email }}
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
