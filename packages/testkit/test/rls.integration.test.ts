import { afterAll, describe, expect, it } from "vitest";
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

    const outsiderClient = createUserClient(outsider.accessToken, env);
    const orgs = await outsiderClient.from("organizations").select("*").eq("id", organizationId);
    expect(orgs.data ?? []).toHaveLength(0);

    const members = await outsiderClient
      .from("organization_members")
      .select("*")
      .eq("organization_id", organizationId);
    expect(members.data ?? []).toHaveLength(0);

    const projects = await outsiderClient.from("projects").select("*").eq("id", projectId);
    expect(projects.data ?? []).toHaveLength(0);

    const insertSelf = await outsiderClient.from("organization_members").insert({
      organization_id: organizationId,
      user_id: outsider.user.id,
      role: "owner",
    });
    expect(insertSelf.error).toBeTruthy();

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
  });
});
