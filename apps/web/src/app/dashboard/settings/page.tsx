import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getPreferredOrganization,
  listDashboardOrganizations,
  organizationDashboardPath,
} from "@/lib/dashboard-organizations";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = dashboardPageMetadata({
  title: "Settings",
  description: "Open settings for your preferred organization.",
  path: "/dashboard/settings",
});

export default async function SettingsPage() {
  const organizations = await listDashboardOrganizations();
  const preferredOrganization = await getPreferredOrganization(organizations);
  if (!preferredOrganization) {
    redirect("/dashboard/new");
  }
  redirect(organizationDashboardPath(preferredOrganization, "settings"));
}
