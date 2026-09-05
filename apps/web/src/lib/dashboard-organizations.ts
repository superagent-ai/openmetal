import "server-only";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireMetalSession } from "@/lib/metal-server";

export const ACTIVE_ORGANIZATION_COOKIE = "metal_active_organization";

export type DashboardOrganization = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
};

export type DashboardSection =
  "api-keys" | "billing" | "members" | "projects" | "providers" | "settings" | "usage" | "webhooks";

export async function listDashboardOrganizations(): Promise<DashboardOrganization[]> {
  const { metal } = await requireMetalSession();
  const result = await metal.organizations.list();
  return result.organizations;
}

export async function getPreferredOrganization(
  organizations: DashboardOrganization[],
): Promise<DashboardOrganization | undefined> {
  const activeOrganizationId = (await cookies()).get(ACTIVE_ORGANIZATION_COOKIE)?.value;
  return (
    organizations.find((organization) => organization.id === activeOrganizationId) ??
    organizations[0]
  );
}

export async function requireOrganizationBySlug(slug: string): Promise<DashboardOrganization> {
  const organizations = await listDashboardOrganizations();
  const organization = organizations.find((candidate) => candidate.slug === slug);
  if (!organization) {
    notFound();
  }
  return organization;
}

export function organizationDashboardPath(
  organization: Pick<DashboardOrganization, "slug">,
  section?: DashboardSection,
): string {
  return `/dashboard/${organization.slug}${section ? `/${section}` : ""}`;
}
