import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeStripeGateway, grantCredits } from "@openmetal/billing";
import { createDatabase, withTransaction } from "@openmetal/db";
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
  const stripe = new FakeStripeGateway();

  beforeAll(async () => {
    apiEnv = loadApiEnv({
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      METAL_SITE_URL: "http://localhost:3100",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3100",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      LOG_LEVEL: "silent",
      METAL_ENVIRONMENT: "test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    const { app } = await buildApp(apiEnv, database, { stripe });
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
      retryable: false,
    });

    const allowed = await runningApp.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "http://127.0.0.1:3100",
        "access-control-request-method": "PUT",
      },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3100");
    expect(allowed.headers["access-control-allow-methods"]).toContain("PUT");

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
      retryable: false,
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
    const [projectRecord] = await database.sql`
      select id from public.projects where public_id = ${project.id}
    `;
    const projectInternalId = String(projectRecord!.id);
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
    const nonexistentId = `prj_${crypto.randomUUID().replaceAll("-", "")}`;

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
          where id = ${projectInternalId} and organization_id = ${first.id}
        ) as resources,
        (
          select count(*)::int from metal.domain_events
          where project_id = ${projectInternalId} and type = 'project.created'
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

  it("grants $500 once per new user under concurrent organization creation", async () => {
    const owner = await createConfirmedUser(env);
    const existingOwner = await createConfirmedUser(env);
    users.push(owner.user.id, existingOwner.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const existingOwnerClient = clientFor(existingOwner.accessToken);

    const [first, second] = await Promise.all([
      ownerClient.organizations.create(
        {
          name: "First Welcome Org",
          slug: `welcome-first-${crypto.randomUUID().slice(0, 8)}`,
        },
        { idempotencyKey: "welcome-first" },
      ),
      ownerClient.organizations.create(
        {
          name: "Second Welcome Org",
          slug: `welcome-second-${crypto.randomUUID().slice(0, 8)}`,
        },
        { idempotencyKey: "welcome-second" },
      ),
    ]);
    const balances = await Promise.all([
      ownerClient.billing.get(first.id),
      ownerClient.billing.get(second.id),
    ]);
    expect(balances.map((billing) => billing.balance_usd).sort()).toEqual(["0.00", "500.00"]);

    const [grantCounts] = await database.sql`
      select
        (
          select count(*)::int
          from metal.user_welcome_credit_grants
          where user_id = ${owner.user.id} and status = 'granted'
        ) as claims,
        (
          select count(*)::int
          from metal.credit_purchases
          where actor_id = ${owner.user.id} and source = 'welcome_grant'
        ) as purchases,
        (
          select count(*)::int
          from metal.domain_events
          where actor_id = ${owner.user.id} and type = 'billing.credits_granted'
        ) as events
    `;
    expect(grantCounts).toMatchObject({ claims: 1, purchases: 1, events: 1 });

    await database.sql`
      insert into metal.user_welcome_credit_grants (
        user_id,
        organization_id,
        credit_microusd,
        status
      )
      values (
        ${existingOwner.user.id},
        ${crypto.randomUUID()},
        0,
        'ineligible_existing'
      )
    `;
    const existingOwnerOrganization = await existingOwnerClient.organizations.create({
      name: "Existing Owner Org",
      slug: `existing-owner-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect((await existingOwnerClient.billing.get(existingOwnerOrganization.id)).balance_usd).toBe(
      "0.00",
    );
  });

  it("updates and safely tombstones organizations with owner confirmation", async () => {
    const owner = await createConfirmedUser(env);
    const admin = await createConfirmedUser(env);
    const member = await createConfirmedUser(env);
    users.push(owner.user.id, admin.user.id, member.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const adminClient = clientFor(admin.accessToken);
    const memberClient = clientFor(member.accessToken);

    const organization = await ownerClient.organizations.create({
      name: "Lifecycle Org",
      slug: `lifecycle-${crypto.randomUUID().slice(0, 8)}`,
    });
    const otherOrganization = await ownerClient.organizations.create({
      name: "Reserved Slug Org",
      slug: `reserved-${crypto.randomUUID().slice(0, 8)}`,
    });
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values
        (${organization.id}, ${admin.user.id}, 'admin'),
        (${organization.id}, ${member.user.id}, 'member')
    `;

    const updated = await adminClient.organizations.update(organization.id, {
      name: "Updated Lifecycle Org",
      slug: `updated-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(updated.name).toBe("Updated Lifecycle Org");
    await expect(
      memberClient.organizations.update(organization.id, {
        name: "Member Edit",
        slug: "member-edit",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      adminClient.organizations.update(organization.id, {
        name: "Duplicate",
        slug: otherOrganization.slug,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      adminClient.organizations.delete(organization.id, {
        confirm_name: updated.name,
        confirm_forfeit_balance: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      ownerClient.organizations.delete(organization.id, {
        confirm_name: "Wrong name",
        confirm_forfeit_balance: true,
      }),
    ).rejects.toMatchObject({ status: 422, code: "confirmation_mismatch" });
    await expect(
      ownerClient.organizations.delete(organization.id, {
        confirm_name: updated.name,
      }),
    ).rejects.toMatchObject({ status: 409, code: "organization_has_credit_balance" });

    const project = await ownerClient.projects.create(organization.id, {
      name: "Lifecycle Project",
      slug: "lifecycle-project",
    });
    await database.sql`
      update metal.auto_topup_policies
      set enabled = true, status = 'active'
      where organization_id = ${otherOrganization.id}
    `;
    const apiKey = await ownerClient.apiKeys.create(project.id, {
      name: "lifecycle key",
      expires_in: null,
    });
    await expect(
      ownerClient.organizations.delete(organization.id, {
        confirm_name: updated.name,
        confirm_forfeit_balance: true,
      }),
    ).resolves.toEqual({ id: organization.id, deleted: true });

    await expect(ownerClient.organizations.get(organization.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(ownerClient.apiKeys.list(project.id)).rejects.toMatchObject({ status: 404 });
    expect((await ownerClient.organizations.list()).organizations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: organization.id })]),
    );
    const [deletedState] = await database.sql`
      select
        organization.deleted_at,
        organization.name,
        organization.slug,
        billing.balance_microusd::text as balance_microusd,
        (
          select count(*)::int
          from public.organization_members
          where organization_id = ${organization.id}
        ) as memberships,
        (
          select count(*)::int
          from public.projects
          where organization_id = ${organization.id} and deleted_at is null
        ) as active_projects,
        (
          select count(*)::int
          from metal.domain_events
          where organization_id = ${organization.id} and type = 'organization.deleted'
        ) as deletion_events
      from public.organizations organization
      join metal.billing_accounts billing on billing.organization_id = organization.id
      where organization.id = ${organization.id}
    `;
    expect(deletedState).toMatchObject({
      name: "Deleted organization",
      balance_microusd: "0",
      memberships: 0,
      active_projects: 0,
      deletion_events: 1,
    });
    expect(deletedState?.deleted_at).toBeTruthy();
    expect(String(deletedState?.slug)).toBe(`deleted-${organization.id}`);
    expect(apiKey.key).toMatch(/^metal_sk_/);
    const [otherBillingPolicy] = await database.sql`
      select enabled, status
      from metal.auto_topup_policies
      where organization_id = ${otherOrganization.id}
    `;
    expect(otherBillingPolicy).toMatchObject({ enabled: true, status: "active" });

    const activeOwner = await createConfirmedUser(env);
    users.push(activeOwner.user.id);
    const activeOwnerClient = clientFor(activeOwner.accessToken);
    const activeOrganization = await activeOwnerClient.organizations.create({
      name: "Active Resource Org",
      slug: `active-resource-${crypto.randomUUID().slice(0, 8)}`,
    });
    const activeProject = await activeOwnerClient.projects.create(activeOrganization.id, {
      name: "Active Resource Project",
      slug: "active-resource-project",
    });
    const activeKey = await activeOwnerClient.apiKeys.create(activeProject.id, {
      name: "active resource key",
      expires_in: null,
    });
    const projectClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => activeKey.key,
      projectId: activeProject.id,
      retry: { attempts: 1 },
    });
    await projectClient.sandboxes.createAsync({
      source: { kind: "environment", environment: "metal/node", version: "1" },
      resources: { vcpu: 1, memory_mb: 1024, architecture: "any" },
      lifecycle: { runtime_timeout_seconds: 600 },
    });
    await expect(
      activeOwnerClient.organizations.delete(activeOrganization.id, {
        confirm_name: activeOrganization.name,
        confirm_forfeit_balance: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "organization_has_active_resources",
    });
  });

  it("encrypts organization BYOK credentials and enforces administrator access", async () => {
    const owner = await createConfirmedUser(env);
    const member = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, member.user.id, outsider.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const memberClient = clientFor(member.accessToken);
    const outsiderClient = clientFor(outsider.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "BYOK Org",
      slug: `byok-${crypto.randomUUID().slice(0, 8)}`,
    });
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organization.id}, ${member.user.id}, 'member')
    `;

    await expect(ownerClient.providerCredentials.list(organization.id)).resolves.toEqual({
      provider_credentials: [],
    });
    await expect(memberClient.providerCredentials.list(organization.id)).resolves.toEqual({
      provider_credentials: [],
    });
    await expect(
      memberClient.providerCredentials.configure(organization.id, {
        provider: "e2b",
        api_key: "member-must-not-save",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      memberClient.providerCredentials.remove(organization.id, "e2b"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(outsiderClient.providerCredentials.list(organization.id)).rejects.toMatchObject({
      status: 403,
    });

    const firstSecret = `e2b-${crypto.randomUUID()}`;
    const configured = await ownerClient.providerCredentials.configure(organization.id, {
      provider: "e2b",
      api_key: firstSecret,
    });
    expect(configured).toMatchObject({
      organization_id: organization.id,
      provider: "e2b",
    });
    expect(JSON.stringify(configured)).not.toContain(firstSecret);

    const stored = await database.sql`
      select
        credentials.id,
        secrets.secret as encrypted_secret,
        secrets.decrypted_secret
      from metal.organization_provider_credentials credentials
      inner join vault.decrypted_secrets secrets on secrets.id = credentials.secret_id
      where credentials.organization_id = ${organization.id}
        and credentials.provider = 'e2b'
    `;
    expect(stored).toHaveLength(1);
    expect(String(stored[0]!.encrypted_secret)).not.toContain(firstSecret);
    expect(JSON.parse(String(stored[0]!.decrypted_secret))).toEqual({
      provider: "e2b",
      api_key: firstSecret,
    });

    const rotatedSecret = `e2b-${crypto.randomUUID()}`;
    const rotated = await ownerClient.providerCredentials.configure(organization.id, {
      provider: "e2b",
      api_key: rotatedSecret,
    });
    expect(rotated.id).toBe(configured.id);
    const [rotatedStored] = await database.sql`
      select secrets.decrypted_secret
      from metal.organization_provider_credentials credentials
      inner join vault.decrypted_secrets secrets on secrets.id = credentials.secret_id
      where credentials.id = ${configured.id}
    `;
    expect(JSON.parse(String(rotatedStored!.decrypted_secret))).toEqual({
      provider: "e2b",
      api_key: rotatedSecret,
    });
    await expect(ownerClient.providerCredentials.remove(organization.id, "e2b")).resolves.toEqual({
      provider: "e2b",
      deleted: true,
    });
    await expect(ownerClient.providerCredentials.list(organization.id)).resolves.toEqual({
      provider_credentials: [],
    });
    const [disabled] = await database.sql`
      select disabled_at
      from metal.organization_provider_credentials
      where id = ${configured.id}
    `;
    expect(disabled?.disabled_at).toBeTruthy();
    await expect(
      ownerClient.providerCredentials.remove(organization.id, "e2b"),
    ).rejects.toMatchObject({ status: 404 });

    const daytonaSecret = `daytona-${crypto.randomUUID()}`;
    const daytona = await ownerClient.providerCredentials.configure(organization.id, {
      provider: "daytona",
      api_key: daytonaSecret,
      organization_id: "daytona-organization",
      target: "us",
    });
    const rotatedDaytonaSecret = `daytona-${crypto.randomUUID()}`;
    const rotatedDaytona = await ownerClient.providerCredentials.configure(organization.id, {
      provider: "daytona",
      api_key: rotatedDaytonaSecret,
    });
    expect(rotatedDaytona.id).toBe(daytona.id);
    const [daytonaStored] = await database.sql`
      select secrets.decrypted_secret
      from metal.organization_provider_credentials credentials
      inner join vault.decrypted_secrets secrets on secrets.id = credentials.secret_id
      where credentials.id = ${daytona.id}
    `;
    expect(JSON.parse(String(daytonaStored!.decrypted_secret))).toEqual({
      provider: "daytona",
      api_key: rotatedDaytonaSecret,
      organization_id: "daytona-organization",
      target: "us",
    });

    const auditEvents = await database.sql`
      select type, payload
      from metal.domain_events
      where organization_id = ${organization.id}
        and type like 'organization.provider_credentials.%'
      order by cursor
    `;
    expect(auditEvents).toMatchObject([
      {
        type: "organization.provider_credentials.configured",
        payload: { provider: "e2b" },
      },
      {
        type: "organization.provider_credentials.rotated",
        payload: { provider: "e2b" },
      },
      {
        type: "organization.provider_credentials.removed",
        payload: { provider: "e2b" },
      },
      {
        type: "organization.provider_credentials.configured",
        payload: { provider: "daytona" },
      },
      {
        type: "organization.provider_credentials.rotated",
        payload: { provider: "daytona" },
      },
    ]);
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
    const [projectRecord] = await database.sql`
      select id from public.projects where public_id = ${project.id}
    `;
    const projectInternalId = String(projectRecord!.id);
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
          ${projectInternalId},
          ${JSON.stringify({ recovered: 1 })}::jsonb,
          ${owner.user.id},
          ${occurredAt}
        ),
        (
          ${gapEventIds[1]},
          'project.created',
          ${organization.id},
          ${projectInternalId},
          ${JSON.stringify({ recovered: 2 })}::jsonb,
          ${owner.user.id},
          ${occurredAt}
        ),
        (
          ${gapEventIds[2]},
          'project.created',
          ${organization.id},
          ${projectInternalId},
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

  it("atomically creates a normalized sandbox and durable operation", async () => {
    const owner = await createConfirmedUser(env);
    users.push(owner.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Sandbox Operation Org",
      slug: `sandbox-op-${crypto.randomUUID().slice(0, 8)}`,
    });
    const project = await ownerClient.projects.create(organization.id, {
      name: "Sandbox Operation Project",
      slug: `sandbox-op-project-${crypto.randomUUID().slice(0, 8)}`,
    });
    await withTransaction(database.db, (tx) =>
      grantCredits(tx, {
        organizationId: organization.id,
        creditMicrousd: 100_000_000n,
        actorId: owner.user.id,
      }),
    );
    const createdKey = await ownerClient.apiKeys.create(project.id, {
      name: "sandbox operation key",
      expires_in: null,
    });
    const projectClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => createdKey.key,
      projectId: project.id,
      retry: { attempts: 1 },
    });
    const request = {
      provider: "codesandbox" as const,
      source: {
        kind: "environment" as const,
        environment: "metal/node",
        version: "1",
      },
      resources: {
        vcpu: 2,
        memory_mb: 4096,
        architecture: "any" as const,
      },
      lifecycle: { runtime_timeout_seconds: 600 },
      fallback: { providers: ["e2b" as const] },
      provider_options: {
        codesandbox: { vm_tier: "Nano" as const },
      },
    };
    const first = await projectClient.sandboxes.createAsync(request, {
      idempotencyKey: "normalized-create",
    });
    const replay = await projectClient.sandboxes.createAsync(request, {
      idempotencyKey: "normalized-create",
    });
    expect(first.sandbox.id).toMatch(/^sbx_/);
    expect(first.operation.id).toMatch(/^op_/);
    expect(first.sandbox.state).toBe("routing");
    expect(first.sandbox.requested.resources.memory_mb).toBe(4096);
    expect(replay).toEqual(first);
    const automatic = await projectClient.sandboxes.createAsync(
      {
        source: {
          kind: "environment",
          environment: "metal/node",
          version: "1",
        },
        resources: {
          vcpu: 1,
          memory_mb: 1024,
          architecture: "any",
        },
        lifecycle: { runtime_timeout_seconds: 600 },
        regions: ["iad1"],
        features: { pty: true, pause_resume: true },
        network: { internet_access: false },
      },
      { idempotencyKey: "automatic-create" },
    );
    expect(automatic.sandbox.requested.provider).toBe("auto");
    expect(automatic.sandbox.provider).toBeNull();
    const firstPage = await projectClient.sandboxes.listScoped({ limit: 1 });
    expect(firstPage.sandboxes).toHaveLength(1);
    expect(firstPage.next_cursor).toBe(firstPage.sandboxes[0]?.id);
    await expect(
      projectClient.sandboxes.listScoped({
        cursor: firstPage.next_cursor ?? undefined,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      sandboxes: [expect.objectContaining({ id: first.sandbox.id })],
    });
    const unscopedClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => createdKey.key,
      retry: { attempts: 1 },
    });
    await expect(unscopedClient.sandboxes.get(first.sandbox.id)).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
    });
    await expect(
      projectClient.sandboxes.get(first.sandbox.id, {
        projectId: `prj_${crypto.randomUUID().replaceAll("-", "")}`,
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(projectClient.operations.get(first.operation.id)).resolves.toMatchObject({
      id: first.operation.id,
      state: "queued",
      resource_id: first.sandbox.id,
    });
    const operationEvents = await fetch(`${appUrl}/v1/operations/${first.operation.id}/events`, {
      headers: { authorization: `Bearer ${createdKey.key}` },
    });
    expect(operationEvents.status).toBe(200);
    expect(await operationEvents.text()).toContain("id: 1");
    const resumedEvents = await fetch(`${appUrl}/v1/operations/${first.operation.id}/events`, {
      headers: {
        authorization: `Bearer ${createdKey.key}`,
        "last-event-id": "1",
      },
    });
    expect(await resumedEvents.text()).toBe("");
    const invalidSequence = await fetch(`${appUrl}/v1/operations/${first.operation.id}/events`, {
      headers: {
        authorization: `Bearer ${createdKey.key}`,
        "last-event-id": "not-a-sequence",
      },
    });
    expect(invalidSequence.status).toBe(422);
    const [counts] = await database.sql`
      select
        (select count(*)::int from metal.operations where public_id = ${first.operation.id}) operations,
        (
          select count(*)::int from metal.outbox_jobs
          where payload->>'operation_id' = (
            select id::text from metal.operations where public_id = ${first.operation.id}
          )
        ) jobs
    `;
    expect(counts).toMatchObject({ operations: 1, jobs: 1 });
  });

  it("invites members to a specific organization and auto-accepts on login", async () => {
    const owner = await createConfirmedUser(env);
    const existing = await createConfirmedUser(env);
    const member = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, existing.user.id, member.user.id, outsider.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const existingClient = clientFor(existing.accessToken);
    const memberClient = clientFor(member.accessToken);
    const outsiderClient = clientFor(outsider.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Invite Org",
      slug: `invite-${crypto.randomUUID().slice(0, 8)}`,
    });
    const otherOrganization = await ownerClient.organizations.create({
      name: "Other Invite Org",
      slug: `invite-other-${crypto.randomUUID().slice(0, 8)}`,
    });
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organization.id}, ${member.user.id}, 'member')
    `;

    await expect(
      ownerClient.invitations.create(organization.id, { email: owner.email, role: "member" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      ownerClient.invitations.create(organization.id, { email: member.email, role: "member" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      memberClient.invitations.create(organization.id, {
        email: `blocked-${crypto.randomUUID()}@example.test`,
        role: "member",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(outsiderClient.members.list(organization.id)).rejects.toMatchObject({
      status: 403,
    });

    const pending = await ownerClient.invitations.create(organization.id, {
      email: existing.email,
      role: "admin",
    });
    expect(pending).toMatchObject({
      organization_id: organization.id,
      email: existing.email.toLowerCase(),
      role: "admin",
      status: "pending",
    });
    const duplicate = await ownerClient.invitations.create(organization.id, {
      email: existing.email.toUpperCase(),
      role: "admin",
    });
    expect(duplicate.id).toBe(pending.id);

    const listedBeforeAccept = await ownerClient.members.list(organization.id);
    expect(listedBeforeAccept.viewer).toEqual({ user_id: owner.user.id, role: "owner" });
    expect(listedBeforeAccept.invitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pending.id, status: "pending" })]),
    );
    await expect(existingClient.organizations.list()).resolves.toMatchObject({
      organizations: expect.arrayContaining([expect.objectContaining({ id: organization.id })]),
    });
    await expect(existingClient.organizations.list()).resolves.not.toMatchObject({
      organizations: expect.arrayContaining([
        expect.objectContaining({ id: otherOrganization.id }),
      ]),
    });
    const afterAccept = await ownerClient.members.list(organization.id);
    expect(afterAccept.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: existing.user.id, role: "admin" }),
      ]),
    );
    expect(
      afterAccept.invitations.find((invitation) => invitation.id === pending.id),
    ).toBeUndefined();

    const newEmail = `new-${crypto.randomUUID()}@example.test`;
    const created = await ownerClient.invitations.create(organization.id, {
      email: newEmail,
      role: "member",
    });
    expect(created).toMatchObject({
      organization_id: organization.id,
      email: newEmail,
      role: "member",
      status: "pending",
    });
    const [invitedUser] = await database.sql`
      select id::text as id from auth.users where lower(email) = ${newEmail}
    `;
    expect(invitedUser?.id).toBeTruthy();
    if (invitedUser?.id) {
      users.push(String(invitedUser.id));
    }
    const otherInvite = await ownerClient.invitations.create(otherOrganization.id, {
      email: newEmail,
      role: "admin",
    });
    expect(otherInvite.organization_id).toBe(otherOrganization.id);
    expect(otherInvite.id).not.toBe(created.id);

    await expect(ownerClient.invitations.revoke(organization.id, created.id)).resolves.toEqual({
      id: created.id,
      revoked: true,
    });
    const afterRevoke = await ownerClient.members.list(organization.id);
    expect(
      afterRevoke.invitations.find((invitation) => invitation.id === created.id),
    ).toBeUndefined();
    const otherMembers = await ownerClient.members.list(otherOrganization.id);
    expect(otherMembers.invitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: otherInvite.id })]),
    );

    await expect(
      memberClient.members.remove(organization.id, existing.user.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(ownerClient.members.remove(organization.id, owner.user.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(ownerClient.members.remove(organization.id, existing.user.id)).resolves.toEqual({
      user_id: existing.user.id,
      deleted: true,
    });
    const afterRemove = await ownerClient.members.list(organization.id);
    expect(afterRemove.members.find((item) => item.user_id === existing.user.id)).toBeUndefined();
  });

  it("lets owners and admins update other members and pending invite roles", async () => {
    const owner = await createConfirmedUser(env);
    const secondOwner = await createConfirmedUser(env);
    const admin = await createConfirmedUser(env);
    const member = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, secondOwner.user.id, admin.user.id, member.user.id, outsider.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const adminClient = clientFor(admin.accessToken);
    const memberClient = clientFor(member.accessToken);
    const outsiderClient = clientFor(outsider.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Role Org",
      slug: `role-${crypto.randomUUID().slice(0, 8)}`,
    });
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values
        (${organization.id}, ${secondOwner.user.id}, 'owner'),
        (${organization.id}, ${admin.user.id}, 'admin'),
        (${organization.id}, ${member.user.id}, 'member')
    `;

    await expect(
      memberClient.members.update(organization.id, admin.user.id, { role: "member" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      outsiderClient.members.update(organization.id, member.user.id, { role: "admin" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      ownerClient.members.update(organization.id, owner.user.id, { role: "admin" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      adminClient.members.update(organization.id, owner.user.id, { role: "member" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      adminClient.members.remove(organization.id, secondOwner.user.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(ownerClient.members.remove(organization.id, secondOwner.user.id)).resolves.toEqual(
      {
        user_id: secondOwner.user.id,
        deleted: true,
      },
    );

    await expect(
      ownerClient.members.update(organization.id, member.user.id, { role: "admin" }),
    ).resolves.toMatchObject({
      user_id: member.user.id,
      role: "admin",
    });
    await expect(
      adminClient.members.update(organization.id, member.user.id, { role: "member" }),
    ).resolves.toMatchObject({
      user_id: member.user.id,
      role: "member",
    });

    const pending = await ownerClient.invitations.create(organization.id, {
      email: outsider.email,
      role: "member",
    });
    await expect(
      memberClient.invitations.update(organization.id, pending.id, { role: "admin" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      ownerClient.invitations.update(organization.id, pending.id, { role: "admin" }),
    ).resolves.toMatchObject({
      id: pending.id,
      role: "admin",
    });
  });

  it("quotes purchases, creates checkout, credits from a verified webhook, and rejects unpaid sandboxes", async () => {
    const owner = await createConfirmedUser(env);
    users.push(owner.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Billing Org",
      slug: `billing-${crypto.randomUUID().slice(0, 8)}`,
    });
    const quote = await ownerClient.billing.quote(organization.id, "100.00");
    expect(quote).toMatchObject({
      credit_usd: "100.00",
      fee_usd: "5.50",
      total_usd: "105.50",
    });
    const checkout = await ownerClient.billing.checkout(organization.id, { amount_usd: "100.00" });
    expect(checkout.checkout_url).toContain("https://checkout.stripe.test/");
    const session = stripe.checkoutSessions.at(-1);
    expect(session).toBeTruthy();
    const paidEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: session?.id,
          mode: "payment",
          payment_status: "paid",
          customer: session?.input.customerId,
          payment_intent: `pi_test_${crypto.randomUUID().replaceAll("-", "")}`,
          payment_method: "pm_test_visa",
          amount_total: 10550,
          currency: "usd",
          metadata: {
            organization_id: organization.id,
            purchase_id: checkout.purchase_id,
          },
        },
      },
    };
    const webhook = await runningApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "test_signature",
      },
      payload: JSON.stringify(paidEvent),
    });
    expect(webhook.statusCode).toBe(200);
    const replay = await runningApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "test_signature",
      },
      payload: JSON.stringify(paidEvent),
    });
    expect(replay.statusCode).toBe(200);
    const billed = await ownerClient.billing.get(organization.id);
    expect(billed.balance_usd).toBe("600.00");
    expect(billed.payment_method).toMatchObject({ last4: "4242" });
    expect(billed.purchases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "paid",
          credit_usd: "100.00",
          receipt_url: expect.stringContaining("https://pay.stripe.test/receipts/"),
          invoice_url: expect.stringContaining("https://invoice.stripe.test/"),
        }),
      ]),
    );

    const enabled = await ownerClient.billing.updateAutoTopup(organization.id, {
      enabled: true,
      threshold_usd: "10.00",
      refill_usd: "50.00",
      monthly_cap_usd: "500.00",
    });
    expect(enabled.auto_topup).toMatchObject({
      enabled: true,
      status: "active",
      refill_usd: "50.00",
    });

    const emptyOrg = await ownerClient.organizations.create({
      name: "Empty Billing Org",
      slug: `billing-empty-${crypto.randomUUID().slice(0, 8)}`,
    });
    const project = await ownerClient.projects.create(emptyOrg.id, {
      name: "Unpaid Project",
      slug: `unpaid-${crypto.randomUUID().slice(0, 8)}`,
    });
    const createdKey = await ownerClient.apiKeys.create(project.id, {
      name: "unpaid key",
      expires_in: null,
    });
    const projectClient = new MetalClient({
      baseUrl: appUrl,
      accessToken: () => createdKey.key,
      projectId: project.id,
      retry: { attempts: 1 },
    });
    await expect(
      projectClient.sandboxes.createAsync(
        {
          source: {
            kind: "environment",
            environment: "metal/node",
            version: "1",
          },
          resources: { vcpu: 1, memory_mb: 1024, architecture: "any" },
          lifecycle: { runtime_timeout_seconds: 600 },
        },
        { idempotencyKey: "unpaid-create" },
      ),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_credits" });
  });

  it("reports organization usage with managed and BYOK cost separated", async () => {
    const owner = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, outsider.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const outsiderClient = clientFor(outsider.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Usage Analytics Org",
      slug: `usage-${crypto.randomUUID().slice(0, 8)}`,
    });
    const project = await ownerClient.projects.create(organization.id, {
      name: "Agent runtime",
      slug: `runtime-${crypto.randomUUID().slice(0, 8)}`,
    });
    const managedId = crypto.randomUUID();
    const byokId = crypto.randomUUID();
    await database.sql`
      insert into metal.sandboxes (
        id, public_id, organization_id, project_id, provider, primary_provider,
        billing_mode, status, source, resource_requirements, lifecycle, fallback,
        provider_options, environment, secret_refs, metadata, created_by,
        provider_resource_id, provider_cost_microusd, ready_at
      )
      values
      (
        ${managedId}, ${`sbx_${managedId.replaceAll("-", "")}`}, ${organization.id},
        (select id from public.projects where public_id = ${project.id}),
        'e2b', 'e2b', 'managed', 'ready',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${owner.user.id}, ${`remote-${managedId}`}, 3000000, '2026-07-20T00:00:00Z'
      ),
      (
        ${byokId}, ${`sbx_${byokId.replaceAll("-", "")}`}, ${organization.id},
        (select id from public.projects where public_id = ${project.id}),
        'runloop', 'runloop', 'byok', 'ready',
        ${JSON.stringify({ kind: "environment", environment: "metal/node", version: "1" })}::jsonb,
        ${JSON.stringify({ vcpu: 1, memory_mb: 512, architecture: "any" })}::jsonb,
        ${JSON.stringify({ runtime_timeout_seconds: 300 })}::jsonb,
        ${JSON.stringify({ providers: [] })}::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${owner.user.id}, ${`remote-${byokId}`}, 3000000, '2026-07-20T00:00:00Z'
      )
    `;
    await database.sql`
      insert into metal.provider_cost_snapshots (
        sandbox_id, organization_id, project_id, provider, provider_resource_id,
        billing_mode, amount_microusd, cost_delta_microusd, measured_from,
        measured_through, cost_provenance, cost_confidence, cost_source, raw_payload
      )
      values
      (
        ${managedId}, ${organization.id},
        (select id from public.projects where public_id = ${project.id}),
        'e2b', ${`remote-${managedId}`}, 'managed', 1000000, 1000000,
        '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z',
        'provider_metered', 'medium', 'e2b-lifecycle-events', '{}'::jsonb
      ),
      (
        ${managedId}, ${organization.id},
        (select id from public.projects where public_id = ${project.id}),
        'e2b', ${`remote-${managedId}`}, 'managed', 3000000, 2000000,
        '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z',
        'provider_metered', 'medium', 'e2b-lifecycle-events', '{}'::jsonb
      ),
      (
        ${byokId}, ${organization.id},
        (select id from public.projects where public_id = ${project.id}),
        'runloop', ${`remote-${byokId}`}, 'byok', 3000000, 3000000,
        '2026-08-02T00:00:00Z', '2026-08-03T00:00:00Z',
        'estimated_rate_card', 'low', 'runloop-published-rate', '{}'::jsonb
      )
    `;

    const usage = await ownerClient.usage.get(organization.id, {
      from: "2026-08-01T00:00:00.000Z",
      through: "2026-08-08T00:00:00.000Z",
    });
    expect(usage.summary.total_cost.current.usd).toBe("5.00");
    expect(usage.summary.managed_cost.current.usd).toBe("2.00");
    expect(usage.summary.byok_cost.current.usd).toBe("3.00");
    expect(usage.by_provider.map((item) => item.provider).sort()).toEqual(["e2b", "runloop"]);
    expect(usage.top_sandboxes).toHaveLength(2);

    const rolling = await ownerClient.usage.get(organization.id, {
      from: "2026-08-02T12:00:00.000Z",
      through: "2026-08-04T12:00:00.000Z",
    });
    expect(rolling.summary.total_cost.current.usd).toBe("3.00");
    expect(rolling.summary.managed_cost.current.usd).toBe("0.00");

    await database.sql`
      update metal.sandboxes
      set status = 'deleted', deleted_at = '2026-08-03T01:00:00Z'
      where id = ${byokId}
    `;
    const stopped = await ownerClient.usage.get(organization.id, {
      from: "2026-08-01T00:00:00.000Z",
      through: "2026-08-08T00:00:00.000Z",
      status: "stopped",
    });
    expect(stopped.summary.total_cost.current.usd).toBe("3.00");
    expect(stopped.top_sandboxes[0]?.status).toBe("stopped");

    await expect(
      outsiderClient.usage.get(organization.id, {
        from: "2026-08-01T00:00:00.000Z",
        through: "2026-08-08T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects invalid Stripe webhooks, mismatched payloads, and double credits", async () => {
    const owner = await createConfirmedUser(env);
    const member = await createConfirmedUser(env);
    users.push(owner.user.id, member.user.id);
    const ownerClient = clientFor(owner.accessToken);
    const memberClient = clientFor(member.accessToken);
    const organization = await ownerClient.organizations.create({
      name: "Webhook Billing Org",
      slug: `wh-${crypto.randomUUID().slice(0, 8)}`,
    });
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organization.id}, ${member.user.id}, 'member')
    `;
    const readableResponse = await runningApp.inject({
      method: "GET",
      url: `/v1/organizations/${organization.id}/billing`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(readableResponse.statusCode).toBe(200);
    const readable = readableResponse.json();
    expect(readable.can_manage).toBe(false);
    await expect(
      memberClient.billing.checkout(organization.id, { amount_usd: "25.00" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      ownerClient.billing.updateAutoTopup(organization.id, {
        enabled: true,
        threshold_usd: "10.00",
        refill_usd: "50.00",
        monthly_cap_usd: "500.00",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const checkout = await ownerClient.billing.checkout(organization.id, { amount_usd: "25.00" });
    const session = stripe.checkoutSessions.at(-1);
    const paidObject = {
      id: session?.id,
      mode: "payment",
      payment_status: "paid",
      customer: session?.input.customerId,
      payment_intent: `pi_${crypto.randomUUID().replaceAll("-", "")}`,
      payment_method: "pm_test_visa",
      amount_total: 2638,
      currency: "usd",
      metadata: {
        organization_id: organization.id,
        purchase_id: checkout.purchase_id,
      },
    };
    const invalidSignature = await runningApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "not-valid",
      },
      payload: JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: { object: paidObject },
      }),
    });
    expect(invalidSignature.statusCode).toBe(400);
    const mismatched = await runningApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "test_signature",
      },
      payload: JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            ...paidObject,
            amount_total: 1,
            currency: "eur",
            customer: "cus_other",
          },
        },
      }),
    });
    expect(mismatched.statusCode).toBe(400);
    const unpaid = await runningApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "test_signature",
      },
      payload: JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: { object: { ...paidObject, payment_status: "unpaid" } },
      }),
    });
    expect(unpaid.statusCode).toBe(200);
    expect((await ownerClient.billing.get(organization.id)).balance_usd).toBe("500.00");

    const firstEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: paidObject },
    };
    const secondEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: paidObject },
    };
    const [first, second] = await Promise.all([
      runningApp.inject({
        method: "POST",
        url: "/v1/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "test_signature",
        },
        payload: JSON.stringify(firstEvent),
      }),
      runningApp.inject({
        method: "POST",
        url: "/v1/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "test_signature",
        },
        payload: JSON.stringify(secondEvent),
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 200]);
    const billed = await ownerClient.billing.get(organization.id);
    expect(billed.balance_usd).toBe("525.00");
    const [entrySum] = await database.sql`
      select coalesce(sum(amount_microusd), 0)::text as total
      from metal.ledger_entries
      where organization_id = ${organization.id}
    `;
    expect(entrySum?.total).toBe("0");
    const [entryId] = await database.sql`
      select id::text as id from metal.ledger_entries
      where organization_id = ${organization.id}
      limit 1
    `;
    await expect(
      database.sql`update metal.ledger_entries set amount_microusd = 1 where id = ${entryId?.id}`,
    ).rejects.toThrow(/append-only/);
  });
});
