import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import { createDatabase } from "@openmetal/db";

loadEnv({ path: "../../.env", override: true });

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

  it("rejects unbalanced ledger entries", async () => {
    const organizationId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (
        ${organizationId},
        'Ledger Org',
        ${`ledger-${organizationId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into metal.billing_accounts (organization_id)
      values (${organizationId})
      on conflict do nothing
    `;
    await expect(
      database.sql.begin(async (sql) => {
        const [transaction] = await sql`
          insert into metal.ledger_transactions (
            organization_id, kind, reference_type, reference_id, description, actor_id
          )
          values (
            ${organizationId},
            'adjustment',
            'test',
            ${crypto.randomUUID()},
            'unbalanced',
            ${crypto.randomUUID()}
          )
          returning id
        `;
        await sql`
          insert into metal.ledger_entries (
            transaction_id, organization_id, account, amount_microusd
          )
          values (
            ${transaction!.id},
            ${organizationId},
            'customer_credits',
            1000
          )
        `;
      }),
    ).rejects.toThrow(/not balanced/);
  });
});
