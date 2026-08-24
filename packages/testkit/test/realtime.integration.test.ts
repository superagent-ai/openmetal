import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { DurableEventEnvelopeSchema } from "@openmetal/contracts";
import { createDatabase } from "@openmetal/db";
import { organizationTopic, projectTopic, serializeCursor } from "@openmetal/events";
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
    const projectPublicId = `prj_${projectId.replaceAll("-", "")}`;
    await database.sql`
      insert into public.organizations (id, name, slug)
      values (${organizationId}, 'Rt Org', ${`rt-${organizationId.slice(0, 8)}`})
    `;
    await database.sql`
      insert into public.organization_members (organization_id, user_id, role)
      values (${organizationId}, ${owner.user.id}, 'owner')
    `;
    await database.sql`
      insert into public.projects (id, public_id, organization_id, name, slug)
      values (${projectId}, ${projectPublicId}, ${organizationId}, 'Rt Project', ${`rtp-${projectId.slice(0, 8)}`})
    `;

    const topic = projectTopic(projectPublicId);
    const ownerClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${owner.accessToken}` } },
    });
    await ownerClient.realtime.setAuth(owner.accessToken);

    const received: unknown[] = [];
    const channel = ownerClient.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (payload) => {
      received.push(payload.payload);
    });
    const subscribed = await new Promise<string>((resolve) => {
      void channel.subscribe((status) => resolve(status));
    });
    expect(subscribed).toBe("SUBSCRIBED");

    const organizationReceived: unknown[] = [];
    const organizationOwnerClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${owner.accessToken}` } },
    });
    await organizationOwnerClient.realtime.setAuth(owner.accessToken);
    const organizationChannel = organizationOwnerClient.channel(organizationTopic(organizationId), {
      config: { private: true },
    });
    organizationChannel.on("broadcast", { event: "*" }, (payload) => {
      organizationReceived.push(payload.payload);
    });
    const organizationSubscribed = await new Promise<string>((resolve) => {
      void organizationChannel.subscribe((status) => resolve(status));
    });
    expect(organizationSubscribed).toBe("SUBSCRIBED");

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
    expect(
      received.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "event_id" in item &&
          item.event_id === "should-fail",
      ),
    ).toBe(false);

    const publisher = createRealtimePublisher({
      supabaseUrl: env.SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
    });
    const eventId = crypto.randomUUID();
    const publicEvent = {
      cursor: serializeCursor(1n),
      event_id: eventId,
      type: "project.created",
      organization_id: organizationId,
      project_id: projectPublicId,
      occurred_at: new Date().toISOString(),
      data: {},
    };
    await publisher.publish(topic, "project.created", publicEvent);

    await waitUntil(
      async () =>
        received.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "event_id" in item &&
            item.event_id === eventId,
        ),
      {
        timeoutMs: 12_000,
      },
    );
    const delivered = received.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "event_id" in item &&
        item.event_id === eventId,
    );
    expect(DurableEventEnvelopeSchema.parse(delivered)).toEqual(publicEvent);
    expect(JSON.stringify(delivered)).not.toMatch(
      /authorization|cookie|token|secret|password|api[_-]?key|database[_-]?url|signed[_-]?url/i,
    );

    const organizationEventId = crypto.randomUUID();
    await publisher.publish(organizationTopic(organizationId), "organization.created", {
      cursor: serializeCursor(2n),
      event_id: organizationEventId,
      type: "organization.created",
      organization_id: organizationId,
      occurred_at: new Date().toISOString(),
      data: {},
    });
    await waitUntil(
      async () =>
        organizationReceived.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "event_id" in item &&
            item.event_id === organizationEventId,
        ),
      { timeoutMs: 12_000 },
    );

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
    const forbiddenOrganization = outsiderClient.channel(organizationTopic(organizationId), {
      config: { private: true },
    });
    const forbiddenOrganizationStatus = await new Promise<string>((resolve) => {
      void forbiddenOrganization.subscribe((status) => resolve(status));
    });
    expect(forbiddenOrganizationStatus).not.toBe("SUBSCRIBED");

    const anonymousClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonymous = anonymousClient.channel(topic, { config: { private: true } });
    const anonymousStatus = await new Promise<string>((resolve) => {
      void anonymous.subscribe((status) => resolve(status));
    });
    expect(anonymousStatus).not.toBe("SUBSCRIBED");

    await ownerClient.removeChannel(channel);
    await organizationOwnerClient.removeChannel(organizationChannel);
    await outsiderClient.removeChannel(forbidden);
    await outsiderClient.removeChannel(forbiddenOrganization);
    await anonymousClient.removeChannel(anonymous);
  });
});
