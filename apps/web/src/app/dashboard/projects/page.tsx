import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getPreferredOrganization,
  listDashboardOrganizations,
  organizationDashboardPath,
} from "@/lib/dashboard-organizations";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = dashboardPageMetadata({
  title: "Projects",
  description: "Open the projects for your preferred organization.",
  path: "/dashboard/projects",
});

export default async function ProjectsPage() {
  const organizations = await listDashboardOrganizations();
  const preferredOrganization = await getPreferredOrganization(organizations);
  if (!preferredOrganization) {
    redirect("/dashboard/new");
  }
  redirect(organizationDashboardPath(preferredOrganization, "projects"));
}
