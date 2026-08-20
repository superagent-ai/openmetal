import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getPreferredOrganization } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

function displayName(email: string): string {
  const local = email.split("@")[0] ?? "Account";
  return local || "Account";
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { claims, metal } = await requireMetalSession();
  const email = typeof claims.email === "string" ? claims.email : "account@metal";
  const { organizations } = await metal.organizations.list();
  const preferredOrganization = await getPreferredOrganization(organizations);

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <AppSidebar
        user={{ name: displayName(email), email }}
        organizations={organizations}
        preferredOrganizationId={preferredOrganization?.id}
      />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SiteHeader
          organizations={organizations}
          preferredOrganizationId={preferredOrganization?.id}
        />
        <ScrollArea className="min-h-0 w-full flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 pt-12">
            {children}
          </div>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  );
}
