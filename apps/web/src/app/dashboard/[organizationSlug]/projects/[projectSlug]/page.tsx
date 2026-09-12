import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectResourcesTable } from "@/components/project-resources-table";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string; projectSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug, projectSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const { projects } = await metal.projects.list(organization.id);
  const project = projects.find((candidate) => candidate.slug === projectSlug);
  if (!project) {
    notFound();
  }
  return dashboardPageMetadata({
    title: project.name,
    description: `Sandboxes and resources in ${project.name}.`,
    path: `/dashboard/${organization.slug}/projects/${project.slug}`,
  });
}

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
  const { sandboxes } = await metal.sandboxes.list(project.id);

  return (
    <>
      <h1 className="sr-only">Resources</h1>
      <ProjectResourcesTable projectId={project.id} sandboxes={sandboxes} />
    </>
  );
}
