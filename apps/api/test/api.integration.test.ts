import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openmetal/db";
import { parseCursor, serializeCursor } from "@openmetal/events";
import { createConfirmedUser, deleteUser, loadTestEnv } from "@openmetal/testkit";
import { MetalClient, MetalError } from "@openmetal/sdk";
import { buildApp } from "../src/app.js";
import { loadApiEnv, type ApiEnv } from "../src/env.js";

const env = loadTestEnv();

describe("metal api integration", () => {
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });
  let appUrl = "";
  let close = async () => {};
  let runningApp: Awaited<ReturnType<typeof buildApp>>["app"];
  let apiEnv: ApiEnv;
  const users: string[] = [];

  beforeAll(async () => {
    apiEnv = loadApiEnv({
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
    runningApp = app;
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

  it("returns stable errors, enforces CORS, reports failed readiness, and shuts down", async () => {
    const requestId = crypto.randomUUID();
    const notFound = await runningApp.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: { "x-request-id": requestId },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers["x-request-id"]).toBe(requestId);
    expect(notFound.json()).toEqual({
      code: "not_found",
      message: "route not found",
      request_id: requestId,
    });

    const allowed = await runningApp.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "http://127.0.0.1:3100",
        "access-control-request-method": "GET",
      },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3100");

    const denied = await runningApp.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();

    let shutdowns = 0;
    const unavailableDatabase = {
      db: database.db,
      sql: database.sql,
      ready: async () => false,
      shutdown: async () => {
        shutdowns += 1;
      },
    };
    const { app: unavailableApp } = await buildApp(apiEnv, unavailableDatabase);
    const readiness = await unavailableApp.inject({ method: "GET", url: "/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({
      status: "not_ready",
      checks: { database: "error" },
    });
    await unavailableApp.close();
    expect(shutdowns).toBe(1);
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

    const invalidRequestId = crypto.randomUUID();
    const invalidPayload = await runningApp.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "x-request-id": invalidRequestId,
      },
      payload: { name: "", slug: "Not Valid" },
    });
    expect(invalidPayload.statusCode).toBe(422);
    expect(invalidPayload.json()).toMatchObject({
      code: "validation_error",
      message: "invalid organization payload",
      request_id: invalidRequestId,
    });

    const slug = `org-${crypto.randomUUID().slice(0, 8)}`;
    const organizationResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        ownerClient.organizations.create(
          { name: "Owner Org", slug },
          { idempotencyKey: "create-org-1" },
        ),
      ),
    );
    const first = organizationResults[0]!;
    expect(new Set(organizationResults.map((item) => item.id))).toEqual(new Set([first.id]));

    const outsiderOrganization = await outsiderClient.organizations.create(
      { name: "Outsider Org", slug: `outsider-${crypto.randomUUID().slice(0, 8)}` },
      { idempotencyKey: "create-org-1" },
    );
    expect(outsiderOrganization.id).not.toBe(first.id);

    await expect(
      ownerClient.organizations.create(
        { name: "Different Body", slug: `${slug}-b` },
        { idempotencyKey: "create-org-1" },
      ),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });

    await expect(outsiderClient.organizations.get(first.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(ownerClient.organizations.get(outsiderOrganization.id)).rejects.toMatchObject({
      status: 403,
    });

    const projectSlug = `p-${crypto.randomUUID().slice(0, 8)}`;
    const projectResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        ownerClient.projects.create(
          first.id,
          { name: "Alpha", slug: projectSlug },
          { idempotencyKey: "create-org-1" },
        ),
      ),
    );
    const project = projectResults[0]!;
    expect(new Set(projectResults.map((item) => item.id))).toEqual(new Set([project.id]));
    await expect(
      ownerClient.projects.create(
        first.id,
        { name: "Different", slug: `${projectSlug}-different` },
        { idempotencyKey: "create-org-1" },
      ),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });

    const member = await createConfirmedUser(env);
    users.push(member.user.id);
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${first.id}, ${member.user.id}, 'member')
    `;
    const memberClient = clientFor(member.accessToken);
    await expect(memberClient.projects.get(project.id)).resolves.toMatchObject({ id: project.id });
    await expect(memberClient.projects.list(first.id)).resolves.toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ id: project.id })]),
    });
    await expect(memberClient.events.list({ projectId: project.id })).resolves.toMatchObject({
      events: expect.any(Array),
    });
    await expect(
      memberClient.projects.create(first.id, { name: "Member Write", slug: "member-write" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      memberClient.projects.update(project.id, { name: "Member Write", slug: "member-write" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(memberClient.projects.delete(project.id)).rejects.toMatchObject({ status: 403 });

    const outsiderProject = await outsiderClient.projects.create(outsiderOrganization.id, {
      name: "Outsider Project",
      slug: `outside-${crypto.randomUUID().slice(0, 8)}`,
    });
    const nonexistentId = crypto.randomUUID();

    await expect(outsiderClient.projects.get(project.id)).rejects.toMatchObject({ status: 404 });
    await expect(outsiderClient.projects.get(nonexistentId)).rejects.toMatchObject({ status: 404 });
    await expect(
      outsiderClient.projects.update(project.id, { name: "Stolen", slug: "stolen" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(outsiderClient.events.list({ projectId: project.id })).rejects.toMatchObject({
      status: 404,
    });
    await expect(outsiderClient.projects.list(first.id)).rejects.toMatchObject({ status: 403 });
    await expect(
      outsiderClient.projects.create(first.id, { name: "Stolen", slug: "stolen" }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(ownerClient.projects.get(outsiderProject.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(ownerClient.events.list({ projectId: outsiderProject.id })).rejects.toMatchObject({
      status: 404,
    });
    await expect(ownerClient.projects.list(outsiderOrganization.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      ownerClient.projects.update(outsiderProject.id, {
        name: "Stolen",
        slug: "stolen",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ownerClient.projects.create(outsiderOrganization.id, {
        name: "Stolen",
        slug: "stolen",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const organizationAtomicCounts = await database.sql`
      select
        (select count(*)::int from public.organizations where id = ${first.id}) as resources,
        (
          select count(*)::int from public.organization_members
          where organization_id = ${first.id} and user_id = ${owner.user.id}
        ) as memberships,
        (
          select count(*)::int from metal.domain_events
          where organization_id = ${first.id} and type = 'organization.created'
        ) as events,
        (
          select count(*)::int from metal.outbox_jobs
          where payload->'event'->>'organization_id' = ${first.id}
            and payload->'event'->>'type' = 'organization.created'
        ) as jobs,
        (
          select count(*)::int from metal.idempotency_keys
          where principal_id = ${owner.user.id} and operation = 'organizations.create'
        ) as idempotency
    `;
    expect(organizationAtomicCounts[0]).toMatchObject({
      resources: 1,
      memberships: 1,
      events: 1,
      jobs: 1,
      idempotency: 1,
    });

    const projectAtomicCounts = await database.sql`
      select
        (
          select count(*)::int from public.projects
          where id = ${project.id} and organization_id = ${first.id}
        ) as resources,
        (
          select count(*)::int from metal.domain_events
          where project_id = ${project.id} and type = 'project.created'
        ) as events,
        (
          select count(*)::int from metal.outbox_jobs
          where payload->'event'->>'project_id' = ${project.id}
            and payload->'event'->>'type' = 'project.created'
        ) as jobs,
        (
          select count(*)::int from metal.idempotency_keys
          where principal_id = ${owner.user.id}
            and operation = ${`projects.create:${first.id}`}
        ) as idempotency
    `;
    expect(projectAtomicCounts[0]).toMatchObject({
      resources: 1,
      events: 1,
      jobs: 1,
      idempotency: 1,
    });

    const updated = await ownerClient.projects.update(project.id, {
      name: "Renamed",
      slug: `renamed-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(updated.name).toBe("Renamed");

    const deletable = await ownerClient.projects.create(first.id, {
      name: "Delete Me",
      slug: `delete-${crypto.randomUUID().slice(0, 8)}`,
    });
    await expect(outsiderClient.projects.delete(deletable.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(ownerClient.projects.delete(deletable.id)).resolves.toEqual({
      id: deletable.id,
      deleted: true,
    });
    await expect(ownerClient.projects.get(deletable.id)).rejects.toMatchObject({ status: 404 });
    await expect(ownerClient.events.list({ projectId: deletable.id })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      ownerClient.projects.update(deletable.id, { name: "Gone", slug: "gone" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(ownerClient.projects.list(first.id)).resolves.not.toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ id: deletable.id })]),
    });
    const reused = await ownerClient.projects.create(first.id, {
      name: "Delete Me",
      slug: deletable.slug,
    });
    expect(reused.slug).toBe(deletable.slug);

    const events = await ownerClient.events.list({ projectId: project.id });
    expect(events.events.some((item) => item.type === "project.created")).toBe(true);
    expect(events.events.some((item) => item.type === "project.updated")).toBe(true);

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

    await expect(
      ownerClient.events.list({ projectId: project.id, after: "not-a-cursor" }),
    ).rejects.toMatchObject({ status: 422, code: "validation_error" });
    await expect(
      ownerClient.events.list({ projectId: project.id, after: serializeCursor(999999999n) }),
    ).rejects.toMatchObject({ status: 422, code: "validation_error" });

    const otherProject = await ownerClient.projects.create(organization.id, {
      name: "Other Project",
      slug: `other-${crypto.randomUUID().slice(0, 8)}`,
    });
    const otherCursor = (await ownerClient.events.list({ projectId: otherProject.id })).events[0]
      ?.cursor;
    expect(otherCursor).toBeTruthy();
    await expect(
      ownerClient.events.list({ projectId: project.id, after: otherCursor }),
    ).rejects.toMatchObject({ status: 422, code: "validation_error" });

    const gapEventIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const occurredAt = "2026-08-20T12:00:00.000Z";
    await database.sql`
      insert into metal.domain_events (
        event_id, type, organization_id, project_id, payload, actor_id, occurred_at
      )
      values
        (
          ${gapEventIds[0]},
          'project.created',
          ${organization.id},
          ${project.id},
          ${JSON.stringify({ recovered: 1 })}::jsonb,
          ${owner.user.id},
          ${occurredAt}
        ),
        (
          ${gapEventIds[1]},
          'project.created',
          ${organization.id},
          ${project.id},
          ${JSON.stringify({ recovered: 2 })}::jsonb,
          ${owner.user.id},
          ${occurredAt}
        ),
        (
          ${gapEventIds[2]},
          'project.created',
          ${organization.id},
          ${project.id},
          ${JSON.stringify({ recovered: 3 })}::jsonb,
          ${owner.user.id},
          ${occurredAt}
        )
    `;

    const recoveredFirstPage = await ownerClient.events.list({
      projectId: project.id,
      after: first?.cursor,
      limit: 2,
    });
    expect(recoveredFirstPage.events.map((item) => item.event_id)).toEqual(gapEventIds.slice(0, 2));
    expect(recoveredFirstPage.next_cursor).toBe(recoveredFirstPage.events[1]?.cursor);
    expect(recoveredFirstPage.events.every((item) => item.occurred_at === occurredAt)).toBe(true);
    expect(recoveredFirstPage.events.map((item) => parseCursor(item.cursor))).toEqual(
      [...recoveredFirstPage.events]
        .map((item) => parseCursor(item.cursor))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );

    const recoveredSecondPage = await ownerClient.events.list({
      projectId: project.id,
      after: recoveredFirstPage.next_cursor ?? undefined,
      limit: 2,
    });
    expect(recoveredSecondPage.events.map((item) => item.event_id)).toEqual([gapEventIds[2]]);
    expect(recoveredSecondPage.next_cursor).toBeNull();
    expect(recoveredSecondPage.events.every((item) => item.event_id !== first?.event_id)).toBe(
      true,
    );
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

  it("rolls project, event, outbox, and idempotency state back on injected failures", async () => {
    const owner = await createConfirmedUser(env);
    users.push(owner.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Failure Injection Org",
      slug: `failure-${crypto.randomUUID().slice(0, 8)}`,
    });

    async function expectNoPartialState(slug: string) {
      const [counts] = await database.sql`
        select
          (select count(*)::int from public.projects where slug = ${slug}) as projects,
          (
            select count(*)::int from metal.domain_events
            where payload->>'slug' = ${slug}
          ) as events,
          (
            select count(*)::int from metal.outbox_jobs
            where payload->'event'->'data'->>'slug' = ${slug}
          ) as jobs,
          (
            select count(*)::int from metal.idempotency_keys
            where principal_id = ${owner.user.id}
              and operation = ${`projects.create:${organization.id}`}
          ) as idempotency
      `;
      expect(counts).toMatchObject({
        projects: 0,
        events: 0,
        jobs: 0,
        idempotency: 0,
      });
    }

    await database.sql`
      create or replace function metal.validation_fail_event()
      returns trigger language plpgsql set search_path = '' as $$
      begin
        raise exception 'injected event failure with Bearer secret-token';
      end;
      $$
    `;
    await database.sql`
      create trigger validation_fail_event
      before insert on metal.domain_events
      for each row execute function metal.validation_fail_event()
    `;
    const eventSlug = `event-fail-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await expect(
        ownerClient.projects.create(
          organization.id,
          { name: "Event Failure", slug: eventSlug },
          { idempotencyKey: "event-failure" },
        ),
      ).rejects.toMatchObject({
        status: 500,
        code: "internal_error",
        message: "internal error",
      });
    } finally {
      await database.sql`drop trigger if exists validation_fail_event on metal.domain_events`;
      await database.sql`drop function if exists metal.validation_fail_event()`;
    }
    await expectNoPartialState(eventSlug);

    await database.sql`
      create or replace function metal.validation_fail_outbox()
      returns trigger language plpgsql set search_path = '' as $$
      begin
        raise exception 'injected outbox failure';
      end;
      $$
    `;
    await database.sql`
      create trigger validation_fail_outbox
      before insert on metal.outbox_jobs
      for each row execute function metal.validation_fail_outbox()
    `;
    const outboxSlug = `outbox-fail-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await expect(
        ownerClient.projects.create(
          organization.id,
          { name: "Outbox Failure", slug: outboxSlug },
          { idempotencyKey: "outbox-failure" },
        ),
      ).rejects.toMatchObject({ status: 500, code: "internal_error" });
    } finally {
      await database.sql`drop trigger if exists validation_fail_outbox on metal.outbox_jobs`;
      await database.sql`drop function if exists metal.validation_fail_outbox()`;
    }
    await expectNoPartialState(outboxSlug);

    await database.sql`
      create or replace function metal.validation_fail_idempotency()
      returns trigger language plpgsql set search_path = '' as $$
      begin
        raise exception 'injected idempotency completion failure';
      end;
      $$
    `;
    await database.sql`
      create trigger validation_fail_idempotency
      before update on metal.idempotency_keys
      for each row execute function metal.validation_fail_idempotency()
    `;
    const idempotencySlug = `idem-fail-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await expect(
        ownerClient.projects.create(
          organization.id,
          { name: "Idempotency Failure", slug: idempotencySlug },
          { idempotencyKey: "idempotency-failure" },
        ),
      ).rejects.toMatchObject({ status: 500, code: "internal_error" });
    } finally {
      await database.sql`
        drop trigger if exists validation_fail_idempotency on metal.idempotency_keys
      `;
      await database.sql`drop function if exists metal.validation_fail_idempotency()`;
    }
    await expectNoPartialState(idempotencySlug);
  });
});
