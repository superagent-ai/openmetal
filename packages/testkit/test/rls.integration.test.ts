import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createDatabase } from "@openmetal/db";
import { createConfirmedUser, createUserClient, deleteUser, loadTestEnv } from "../src/index.js";

const env = loadTestEnv();

describe("rls isolation", () => {
  const users: string[] = [];
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });

  afterAll(async () => {
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await database.shutdown();
  });

  it("prevents cross-organization reads and self-insert membership", async () => {
    const owner = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, outsider.user.id);
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const outsiderOrganizationId = crypto.randomUUID();
    const slug = `rls-${organizationId.slice(0, 8)}`;

    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'RLS Org', ${slug})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organizationId}, ${owner.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, organization_id, name, slug)
      values (${projectId}, ${organizationId}, 'RLS Project', ${`p-${projectId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (
        ${outsiderOrganizationId},
        'Outsider RLS Org',
        ${`rls-${outsiderOrganizationId.slice(0, 8)}`}
      )
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${outsiderOrganizationId}, ${outsider.user.id}, 'owner')
    `;

    const outsiderClient = createUserClient(outsider.accessToken, env);
    const orgs = await outsiderClient.from("organizations").select("*").eq("id", organizationId);
    expect(orgs.data ?? []).toHaveLength(0);

    const members = await outsiderClient
      .from("organization_members")
      .select("*")
      .eq("organization_id", organizationId);
    expect(members.data ?? []).toHaveLength(0);

    const invitations = await outsiderClient
      .from("organization_invitations")
      .select("*")
      .eq("organization_id", organizationId);
    expect(invitations.data ?? []).toHaveLength(0);

    const projects = await outsiderClient.from("projects").select("*").eq("id", projectId);
    expect(projects.data ?? []).toHaveLength(0);

    const insertSelf = await outsiderClient.from("organization_members").insert({
      organization_id: organizationId,
      user_id: outsider.user.id,
      role: "owner",
    });
    expect(insertSelf.error).toBeTruthy();

    const insertInvite = await outsiderClient.from("organization_invitations").insert({
      organization_id: organizationId,
      email: outsider.email.toLowerCase(),
      role: "member",
      invited_by: outsider.user.id,
    });
    expect(insertInvite.error).toBeTruthy();

    const crossOrganizationInsert = await outsiderClient.from("projects").insert({
      organization_id: organizationId,
      name: "Cross Tenant",
      slug: `cross-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(crossOrganizationInsert.error).toBeTruthy();

    const ownerClient = createUserClient(owner.accessToken, env);
    const visible = await ownerClient.from("organizations").select("*").eq("id", organizationId);
    expect(visible.data ?? []).toHaveLength(1);

    const roleUpdate = await ownerClient
      .from("organization_members")
      .update({ role: "member" })
      .eq("organization_id", organizationId)
      .eq("user_id", owner.user.id)
      .select();
    expect(roleUpdate.data ?? []).toHaveLength(0);

    const crossOrganizationUpdate = await ownerClient
      .from("projects")
      .update({ organization_id: outsiderOrganizationId })
      .eq("id", projectId)
      .select();
    expect(crossOrganizationUpdate.error).toBeTruthy();
    expect(crossOrganizationUpdate.data ?? []).toHaveLength(0);

    const anonymousClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonymousOrganizations = await anonymousClient.from("organizations").select("*");
    expect(anonymousOrganizations.data ?? []).toHaveLength(0);
    expect(anonymousOrganizations.error).toBeTruthy();

    await database.sql`
      update public.projects set deleted_at = now() where id = ${projectId}
    `;
    const deletedProject = await ownerClient.from("projects").select("*").eq("id", projectId);
    expect(deletedProject.data ?? []).toHaveLength(0);
  });

  it("enables RLS, preserves least-privilege grants, and keeps definer helpers unexposed", async () => {
    const rlsRows = await database.sql`
      select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity as enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where (n.nspname, c.relname) in (
        ('public', 'organizations'),
        ('public', 'organization_members'),
        ('public', 'organization_invitations'),
        ('public', 'projects'),
        ('metal', 'domain_events'),
        ('metal', 'organization_provider_credentials'),
        ('metal', 'outbox_jobs'),
        ('metal', 'idempotency_keys'),
        ('metal', 'billing_accounts'),
        ('metal', 'ledger_entries')
      )
      order by n.nspname, c.relname
    `;
    expect(rlsRows).toHaveLength(10);
    expect(rlsRows.every((row) => row.enabled === true)).toBe(true);

    const unsafeGrants = await database.sql`
      select table_schema, table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where (
        grantee = 'anon'
        and table_schema = 'public'
        and table_name in ('organizations', 'organization_members', 'organization_invitations', 'projects')
      ) or (
        grantee = 'authenticated'
        and table_schema = 'metal'
        and table_name in (
          'domain_events',
          'organization_provider_credentials',
          'outbox_jobs',
          'idempotency_keys',
          'billing_accounts',
          'ledger_entries'
        )
      )
    `;
    expect(unsafeGrants).toEqual([]);

    const projectGrants = await database.sql`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'authenticated'
        and table_schema = 'public'
        and table_name = 'projects'
      order by privilege_type
    `;
    expect(projectGrants.map((grant) => grant.privilege_type)).toEqual(["SELECT"]);

    const invitationGrants = await database.sql`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'authenticated'
        and table_schema = 'public'
        and table_name = 'organization_invitations'
      order by privilege_type
    `;
    expect(invitationGrants.map((grant) => grant.privilege_type)).toEqual(["SELECT"]);

    const updatePolicies = await database.sql`
      select schemaname, tablename, policyname, qual, with_check
      from pg_policies
      where cmd = 'UPDATE'
        and schemaname = 'public'
        and tablename in ('organization_members', 'organization_invitations', 'projects')
    `;
    expect(updatePolicies).toHaveLength(3);
    expect(updatePolicies.every((policy) => policy.qual && policy.with_check)).toBe(true);

    const unsafeViews = await database.sql`
      select schemaname, viewname
      from pg_views
      where schemaname in ('public', 'metal')
    `;
    expect(unsafeViews).toEqual([]);

    const unsafePublicDefiners = await database.sql`
      select n.nspname as schema_name, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef = true and n.nspname = 'public'
    `;
    expect(unsafePublicDefiners).toEqual([]);

    const definerHelpers = await database.sql`
      select p.proname, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef = true and n.nspname = 'metal'
    `;
    expect(definerHelpers.map((row) => row.proname).sort()).toEqual([
      "delete_provider_credential_secret",
      "has_organization_role",
      "is_organization_member",
      "is_project_member",
      "project_topic_id",
    ]);
    expect(
      definerHelpers.every(
        (row) => Array.isArray(row.proconfig) && row.proconfig.includes('search_path=""'),
      ),
    ).toBe(true);
  });
});
