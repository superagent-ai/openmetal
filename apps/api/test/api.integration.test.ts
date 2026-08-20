import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";
import { createConfirmedUser, deleteUser, loadTestEnv } from "@openmetal/testkit";
import { MetalClient, MetalError } from "@openmetal/sdk";
import { buildApp } from "../src/app.js";
import { loadApiEnv } from "../src/env.js";

const env = loadTestEnv();

describe("metal api integration", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  let appUrl = "";
  let close = async () => {};
  const users: string[] = [];

  beforeAll(async () => {
    const apiEnv = loadApiEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3100",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
    });
    const { app } = await buildApp(apiEnv, database);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    appUrl = address;
    close = () => app.close();
  });

  afterAll(async () => {
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await close();
  });

  function clientFor(token: string) {
    return new MetalClient({ baseUrl: appUrl, accessToken: async () => token });
  }

  it("serves health, ready, and meta", async () => {
    const client = clientFor("unused");
    await expect(client.health()).resolves.toEqual({ status: "ok" });
    const ready = await client.ready();
    expect(ready.status).toBe("ready");
    const meta = await client.meta();
    expect(meta.api_version).toBe("v1");
  });

  it("rejects missing, malformed, and unverified tokens", async () => {
    const missing = new MetalClient({ baseUrl: appUrl, accessToken: async () => null });
    await expect(missing.organizations.list()).rejects.toMatchObject({ status: 401 });

    const malformed = clientFor("not-a-jwt");
    await expect(malformed.organizations.list()).rejects.toBeInstanceOf(MetalError);

    const forged = clientFor(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.signature",
    );
    await expect(forged.organizations.list()).rejects.toMatchObject({ status: 401 });
  });

  it("isolates organizations and supports idempotent creates", async () => {
    const owner = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, outsider.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const outsiderClient = clientFor(outsider.accessToken);

    const slug = `org-${crypto.randomUUID().slice(0, 8)}`;
    const first = await ownerClient.organizations.create(
      { name: "Owner Org", slug },
      { idempotencyKey: "create-org-1" },
    );
    const replay = await ownerClient.organizations.create(
      { name: "Owner Org", slug },
      { idempotencyKey: "create-org-1" },
    );
    expect(replay.id).toBe(first.id);

    await expect(
      ownerClient.organizations.create(
        { name: "Different Body", slug: `${slug}-b` },
        { idempotencyKey: "create-org-1" },
      ),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });

    await expect(outsiderClient.organizations.get(first.id)).rejects.toMatchObject({
      status: 403,
    });

    const project = await ownerClient.projects.create(
      first.id,
      { name: "Alpha", slug: `p-${crypto.randomUUID().slice(0, 8)}` },
      { idempotencyKey: "create-project-1" },
    );
    await expect(outsiderClient.projects.get(project.id)).rejects.toMatchObject({ status: 403 });
    await expect(outsiderClient.events.list({ projectId: project.id })).rejects.toMatchObject({
      status: 403,
    });

    const events = await ownerClient.events.list({ projectId: project.id });
    expect(events.events.some((item) => item.type === "project.created")).toBe(true);

    const page = await ownerClient.events.list({
      projectId: project.id,
      after: events.events[0]?.cursor,
    });
    expect(page.events.every((item) => item.event_id !== events.events[0]?.event_id)).toBe(true);
  });

  it("recovers a committed project event after a cursor gap", async () => {
    const owner = await createConfirmedUser(env);
    users.push(owner.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Recovery Org",
      slug: `rec-${crypto.randomUUID().slice(0, 8)}`,
    });
    const project = await ownerClient.projects.create(organization.id, {
      name: "Recovery Project",
      slug: `recp-${crypto.randomUUID().slice(0, 8)}`,
    });
    const firstPage = await ownerClient.events.list({ projectId: project.id });
    const first = firstPage.events[0];
    expect(first?.cursor).toBeTruthy();

    const gapEventId = crypto.randomUUID();
    await database.sql`
      insert into metal.domain_events (
        event_id, type, organization_id, project_id, payload, actor_id
      )
      values (
        ${gapEventId},
        'project.created',
        ${organization.id},
        ${project.id},
        ${JSON.stringify({ recovered: true })}::jsonb,
        ${owner.user.id}
      )
    `;

    const recovered = await ownerClient.events.list({
      projectId: project.id,
      after: first?.cursor,
    });
    expect(recovered.events.map((item) => item.event_id)).toContain(gapEventId);
    expect(recovered.events.every((item) => item.event_id !== first?.event_id)).toBe(true);
    expect(recovered.events.some((item) => item.data.recovered === true)).toBe(true);
  });

  it("creates organization, event, and outbox job atomically", async () => {
    const owner = await createConfirmedUser(env);
    users.push(owner.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const slug = `atomic-${crypto.randomUUID().slice(0, 8)}`;
    const organization = await ownerClient.organizations.create({
      name: "Atomic Org",
      slug,
    });

    const eventCount = await database.sql`
      select count(*)::int as count
      from metal.domain_events
      where organization_id = ${organization.id}
    `;
    const jobCount = await database.sql`
      select count(*)::int as count
      from metal.outbox_jobs
      where payload->>'topic' = ${`organization:${organization.id}`}
         or payload->'event'->>'organization_id' = ${organization.id}
    `;
    expect(eventCount[0]?.count).toBeGreaterThan(0);
    expect(jobCount[0]?.count).toBeGreaterThan(0);
  });
});
