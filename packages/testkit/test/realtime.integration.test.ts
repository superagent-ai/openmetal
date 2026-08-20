import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createDatabase } from "@openmetal/db";
import { projectTopic } from "@openmetal/events";
import { createConfirmedUser, deleteUser, loadTestEnv, waitUntil } from "../src/index.js";
import { createRealtimePublisher } from "../../../apps/worker/src/publisher.ts";

const env = loadTestEnv();

describe("private realtime", () => {
  const users: string[] = [];
  const database = createDatabase({ DATABASE_URL: env.DATABASE_URL });

  afterAll(async () => {
    await Promise.all(users.map((id) => deleteUser(id, env)));
    await database.shutdown();
  });

  it("delivers to members, rejects unauthorized joins and customer publishes", async () => {
    const owner = await createConfirmedUser(env);
    const outsider = await createConfirmedUser(env);
    users.push(owner.user.id, outsider.user.id);
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'Rt Org', ${`rt-${organizationId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organizationId}, ${owner.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, organization_id, name, slug)
      values (${projectId}, ${organizationId}, 'Rt Project', ${`rtp-${projectId.slice(0, 8)}`})
    `;

    const topic = projectTopic(projectId);
    const ownerClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${owner.accessToken}` } },
    });
    await ownerClient.realtime.setAuth(owner.accessToken);

    const received: Array<{ event_id?: string }> = [];
    const channel = ownerClient.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (payload) => {
      received.push(payload.payload as { event_id?: string });
    });
    const subscribed = await new Promise<string>((resolve) => {
      void channel.subscribe((status) => resolve(status));
    });
    expect(subscribed).toBe("SUBSCRIBED");

    const sendResult = await channel.send({
      type: "broadcast",
      event: "project.created",
      payload: { event_id: "should-fail" },
    });
    void sendResult;
    const restPublish = await fetch(
      `${env.SUPABASE_URL}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/project.created?private=true`,
      {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_id: "should-fail" }),
      },
    );
    expect(restPublish.ok).toBe(false);
    expect(received.some((item) => item.event_id === "should-fail")).toBe(false);

    const publisher = createRealtimePublisher({
      supabaseUrl: env.SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
    });
    const eventId = crypto.randomUUID();
    await publisher.publish(topic, "project.created", {
      cursor: "c1",
      event_id: eventId,
      type: "project.created",
      organization_id: organizationId,
      project_id: projectId,
      occurred_at: new Date().toISOString(),
      data: {},
    });

    await waitUntil(async () => received.some((item) => item.event_id === eventId), {
      timeoutMs: 12_000,
    });

    const outsiderClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${outsider.accessToken}` } },
    });
    await outsiderClient.realtime.setAuth(outsider.accessToken);
    const forbidden = outsiderClient.channel(topic, { config: { private: true } });
    const forbiddenStatus = await new Promise<string>((resolve) => {
      void forbidden.subscribe((status) => resolve(status));
    });
    expect(forbiddenStatus).not.toBe("SUBSCRIBED");

    await ownerClient.removeChannel(channel);
    await outsiderClient.removeChannel(forbidden);
  });
});
