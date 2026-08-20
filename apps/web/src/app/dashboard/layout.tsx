import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
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
    <SidebarProvider>
      <AppSidebar
        user={{ name: displayName(email), email }}
        organizations={organizations}
        preferredOrganizationId={preferredOrganization?.id}
      />
      <SidebarInset>
        <SiteHeader
          organizations={organizations}
          preferredOrganizationId={preferredOrganization?.id}
        />
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
