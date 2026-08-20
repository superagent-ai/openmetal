import { redirect } from "next/navigation";
import {
  getPreferredOrganization,
  listDashboardOrganizations,
  organizationDashboardPath,
} from "@/lib/dashboard-organizations";

export default async function ProjectsPage() {
  const organizations = await listDashboardOrganizations();
  const preferredOrganization = await getPreferredOrganization(organizations);
  if (!preferredOrganization) {
    redirect("/dashboard/new");
  }
  redirect(organizationDashboardPath(preferredOrganization, "projects"));
}
