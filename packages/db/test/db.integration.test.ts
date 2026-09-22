import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "@dotenvx/dotenvx";
import { createDatabase } from "@openmetal/db";

const root = resolve(import.meta.dirname, "../../..");
loadEnv({
  path: [".env.local", ".env"]
    .map((name) => resolve(root, name))
    .filter((file) => existsSync(file)),
  quiet: true,
});

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

  it("accepts a 48 hour sandbox ttl and rejects one minute more", async () => {
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (
        ${organizationId},
        'TTL Org',
        ${`ttl-${organizationId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into public.projects (id, organization_id, name, slug)
      values (
        ${projectId},
        ${organizationId},
        'TTL Project',
        ${`ttl-${projectId.slice(0, 8)}`}
      )
    `;
    const sandbox = {
      source: JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" }),
      resources: JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" }),
      fallback: JSON.stringify({ providers: [] }),
    };
    await expect(
      database.sql`
        insert into metal.sandboxes (
          organization_id, project_id, provider, primary_provider, billing_mode, status,
          source, resource_requirements, lifecycle, fallback, provider_options, environment,
          secret_refs, metadata, ttl_minutes, created_by
        )
        values (
          ${organizationId}, ${projectId}, 'e2b', 'e2b', 'managed', 'requested',
          ${sandbox.source}::jsonb,
          ${sandbox.resources}::jsonb,
          ${JSON.stringify({ runtime_timeout_seconds: 172_800 })}::jsonb,
          ${sandbox.fallback}::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          2880, ${crypto.randomUUID()}
        )
      `,
    ).resolves.toHaveLength(0);
    await expect(
      database.sql`
        insert into metal.sandboxes (
          organization_id, project_id, provider, primary_provider, billing_mode, status,
          source, resource_requirements, lifecycle, fallback, provider_options, environment,
          secret_refs, metadata, ttl_minutes, created_by
        )
        values (
          ${organizationId}, ${projectId}, 'e2b', 'e2b', 'managed', 'requested',
          ${sandbox.source}::jsonb,
          ${sandbox.resources}::jsonb,
          ${JSON.stringify({ runtime_timeout_seconds: 172_860 })}::jsonb,
          ${sandbox.fallback}::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          2881, ${crypto.randomUUID()}
        )
      `,
    ).rejects.toThrow(/sandboxes_ttl_range/);
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
