import { redirect } from "next/navigation";
import { ControlPlane } from "@/components/control-plane";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

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
