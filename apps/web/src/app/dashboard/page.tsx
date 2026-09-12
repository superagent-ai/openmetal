import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getPreferredOrganization,
  listDashboardOrganizations,
  organizationDashboardPath,
} from "@/lib/dashboard-organizations";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = dashboardPageMetadata({
  title: "Dashboard",
  description: "Open your organization dashboard to manage projects and sandboxes.",
  path: "/dashboard",
});

export default async function DashboardPage() {
  const organizations = await listDashboardOrganizations();
  const preferredOrganization = await getPreferredOrganization(organizations);
  if (!preferredOrganization) {
    redirect("/dashboard/new");
  }
  redirect(organizationDashboardPath(preferredOrganization));
}
