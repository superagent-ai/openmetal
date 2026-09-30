import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MetalError, type MetalClient } from "@openmetal/sdk";
import { GpuJobDetail } from "@/components/gpu-job-detail";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";

type Params = Promise<{ organizationSlug: string; projectSlug: string; gpuJobId: string }>;

async function loadGpuJob(params: Params) {
  const { organizationSlug, projectSlug, gpuJobId } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const { projects } = await metal.projects.list(organization.id);
  const project = projects.find((candidate) => candidate.slug === projectSlug);
  if (!project) {
    notFound();
  }
  const gpuJob = await getGpuJobOrNotFound(metal, project.id, gpuJobId);
  return { organization, project, gpuJob };
}

async function getGpuJobOrNotFound(metal: MetalClient, projectId: string, gpuJobId: string) {
  try {
    return await metal.gpuJobs.getForProject(projectId, gpuJobId);
  } catch (error) {
    if (error instanceof MetalError && (error.status === 404 || error.status === 422)) {
      notFound();
    }
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { organization, project, gpuJob } = await loadGpuJob(params);
  return dashboardPageMetadata({
    title: `GPU job ${gpuJob.id}`,
    description: `GPU job details and logs in ${project.name}.`,
    path: `/dashboard/${organization.slug}/projects/${project.slug}/gpu-jobs/${gpuJob.id}`,
  });
}

export default async function GpuJobPage({ params }: { params: Params }) {
  const { organization, project, gpuJob } = await loadGpuJob(params);
  return (
    <GpuJobDetail
      organizationSlug={organization.slug}
      projectId={project.id}
      projectSlug={project.slug}
      gpuJob={gpuJob}
    />
  );
}
