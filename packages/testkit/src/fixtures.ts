import { createDatabase } from "@openmetal/db";
import { loadTestEnv, type TestEnv } from "./env.js";

export async function insertCommittedProjectEvent(
  input: {
    eventId: string;
    organizationId: string;
    projectId: string;
    actorId: string;
    data?: Record<string, unknown>;
  },
  env: TestEnv = loadTestEnv(),
): Promise<void> {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  try {
    await database.sql`
      insert into metal.domain_events (
        event_id, type, organization_id, project_id, payload, actor_id
      )
      values (
        ${input.eventId},
        'project.created',
        ${input.organizationId},
        ${input.projectId},
        ${JSON.stringify(input.data ?? {})}::jsonb,
        ${input.actorId}
      )
    `;
  } finally {
    await database.shutdown();
  }
}
