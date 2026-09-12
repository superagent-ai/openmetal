import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ControlPlane } from "@/components/control-plane";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  return dashboardPageMetadata({
    title: "Projects",
    description: `Create and manage sandbox projects for ${organization.name}.`,
    path: `/dashboard/${organization.slug}/projects`,
  });
}

export default async function OrganizationProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { organizationSlug } = await params;
  const { project: initialProjectId } = await searchParams;
  const organization = await requireOrganizationBySlug(organizationSlug);
  if (initialProjectId) {
    const { metal } = await requireMetalSession();
    const { projects } = await metal.projects.list(organization.id);
    const project = projects.find((candidate) => candidate.id === initialProjectId);
    if (project) {
      redirect(`/dashboard/${organization.slug}/projects/${project.slug}`);
    }
  }

  return <ControlPlane key={organization.id} organization={organization} />;
}
