import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
};

describe("database readiness", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });

  beforeAll(async () => {
    expect(await database.ready()).toBe(true);
  });

  afterAll(async () => {
    await database.shutdown();
  });

  it("rejects updates to domain events", async () => {
    const organizationId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (
        ${organizationId},
        'Append Only Org',
        ${`append-${organizationId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into metal.domain_events (event_id, type, organization_id, payload, actor_id)
      values (
        ${eventId},
        'organization.created',
        ${organizationId},
        '{}'::jsonb,
        ${crypto.randomUUID()}
      )
    `;
    await expect(
      database.sql`
        update metal.domain_events set type = 'nope' where event_id = ${eventId}
      `,
    ).rejects.toThrow(/append-only/);
    await expect(
      database.sql`delete from metal.domain_events where event_id = ${eventId}`,
    ).rejects.toThrow(/append-only/);
  });
});
