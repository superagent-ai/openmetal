import type { Sql } from "postgres";

/**
 * Removes the GPU jobs of test organizations with their queued work, operations,
 * and cost records, so pending outbox jobs do not leak into later test runs.
 * Deleting a job also deletes its Vault secret through a trigger.
 */
export async function deleteGpuJobsForOrganizations(sql: Sql, organizationIds: string[]) {
  if (organizationIds.length === 0) return;
  await sql.begin(async (tx) => {
    const jobs = await tx<{ id: string }[]>`
      select id from metal.gpu_jobs where organization_id = any(${organizationIds}::uuid[])
    `;
    const ids = jobs.map((job) => job.id);
    if (ids.length === 0) return;
    await tx`delete from metal.outbox_jobs where payload ->> 'gpu_job_id' = any(${ids}::text[])`;
    await tx`
      delete from metal.operation_events
      where operation_id in (select id from metal.operations where gpu_job_id = any(${ids}::uuid[]))
    `;
    await tx`delete from metal.operations where gpu_job_id = any(${ids}::uuid[])`;
    await tx`delete from metal.provider_attempts where gpu_job_id = any(${ids}::uuid[])`;
    await tx`delete from metal.usage_charges where gpu_job_id = any(${ids}::uuid[])`;
    await tx`delete from metal.provider_cost_snapshots where gpu_job_id = any(${ids}::uuid[])`;
    await tx`delete from metal.gpu_jobs where id = any(${ids}::uuid[])`;
  });
}
