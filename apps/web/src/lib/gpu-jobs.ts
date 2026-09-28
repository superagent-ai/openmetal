import type { GpuJob, MetalClient } from "@openmetal/sdk";

export const TERMINAL_GPU_JOB_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const GPU_NAMES: Record<string, string> = {
  "nvidia-t4": "T4",
  "nvidia-l4": "L4",
  "nvidia-a10": "A10",
  "nvidia-l40s": "L40S",
  "nvidia-a100-40gb": "A100 40 GB",
  "nvidia-a100-80gb": "A100 80 GB",
  "nvidia-rtx-pro-6000": "RTX PRO 6000",
  "nvidia-h100": "H100",
  "nvidia-h200": "H200",
  "nvidia-b200": "B200",
  "nvidia-b300": "B300",
};

export function gpuDisplayName(type: string): string {
  return GPU_NAMES[type] ?? type.replace(/^nvidia-/, "").toUpperCase();
}

export function gpuJobGpuLabel(job: Pick<GpuJob, "requested">): string {
  return `${job.requested.gpu.count} × ${gpuDisplayName(job.requested.gpu.type)}`;
}

export function gpuJobHref(organizationSlug: string, projectSlug: string, gpuJobId: string) {
  return `/dashboard/${organizationSlug}/projects/${projectSlug}/gpu-jobs/${gpuJobId}`;
}

export function isGpuJobCancellable(state: string): boolean {
  return !TERMINAL_GPU_JOB_STATES.has(state) && state !== "cancelling";
}

const STATE_REASON_LABELS: Record<string, string> = {
  exit_code_nonzero: "The command exited with a non-zero code",
  provider_init_failed: "The container did not start",
  provider_terminated: "The provider stopped the job before it finished",
  provider_lost: "The provider no longer has this job",
  provider_internal_failure: "The provider reported an internal error",
  provider_idle_timeout: "The provider stopped the job for inactivity",
  no_eligible_provider: "No configured provider could run this job",
  provider_unknown_outcome: "The provider did not confirm whether the job started",
  submit_failed: "The job could not be submitted",
  secrets_unavailable: "The job's secrets were no longer available",
  max_runtime_exceeded: "The job exceeded its maximum runtime",
  cancelled_by_user: "Cancelled by a user",
  max_cost_reached: "Cancelled when its cost reached the limit",
  insufficient_credits: "The organization does not have enough credits for this job",
  waiting_for_organization_gpu_limit:
    "Waiting for the organization's other GPU jobs to finish before starting",
  waiting_for_gpu_capacity: "Waiting for managed GPU capacity",
  start_deadline_exceeded: "No GPU became available before max_start_seconds",
  gpu_limit_exceeded: "The job asks for more GPUs than the organization may use at once",
};

export function gpuJobReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return STATE_REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
}

/** Loads every GPU job in a project, newest first, up to `maxPages` pages of 100. */
export async function listAllProjectGpuJobs(
  metal: Pick<MetalClient, "gpuJobs">,
  projectId: string,
  maxPages = 10,
): Promise<GpuJob[]> {
  const jobs: GpuJob[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await metal.gpuJobs.listForProject(projectId, { cursor, limit: 100 });
    jobs.push(...result.gpu_jobs);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return jobs;
}
