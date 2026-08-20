import { notFound } from "next/navigation";
import { ControlPlane } from "@/components/control-plane";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; projectSlug: string }>;
}) {
  const { organizationSlug, projectSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const { projects } = await metal.projects.list(organization.id);
  const project = projects.find((candidate) => candidate.slug === projectSlug);
  if (!project) {
    notFound();
  }

  return (
    <ControlPlane
      key={`${organization.id}:${project.id}`}
      organization={organization}
      initialProjectId={project.id}
    />
  );
}
