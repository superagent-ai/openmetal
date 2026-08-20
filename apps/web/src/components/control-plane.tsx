"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, Plugs, PlugsConnected, WarningCircle } from "@phosphor-icons/react";
import { isDuplicateDelivery, projectTopic } from "@openmetal/events";
import { MetalError } from "@openmetal/sdk";
import { createClient } from "@/lib/supabase/client";
import { createMetalClient } from "@/lib/metal";

type Organization = { id: string; name: string; slug: string };
type Project = { id: string; name: string; slug: string; organization_id: string };
type EventItem = {
  cursor: string;
  event_id: string;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
};
type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

export function ControlPlane() {
  const supabase = useMemo(() => createClient(), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [health, setHealth] = useState<string>("checking");
  const [meta, setMeta] = useState<string>("");
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const seen = useRef(new Set<string>());
  const cursorRef = useRef<string | undefined>(undefined);

  const ingest = useCallback((incoming: EventItem[]) => {
    setEvents((current) => {
      const next = [...current];
      for (const item of incoming) {
        if (isDuplicateDelivery(seen.current, item.event_id, item.cursor)) {
          continue;
        }
        next.push(item);
        cursorRef.current = item.cursor;
      }
      return next.slice(-20);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [healthResult, metaResult, orgResult] = await Promise.all([
          metal.health(),
          metal.meta(),
          metal.organizations.list(),
        ]);
        if (cancelled) {
          return;
        }
        setHealth(healthResult.status);
        setMeta(`${metaResult.name} ${metaResult.api_version}`);
        setOrganizations(orgResult.organizations);
        setSelectedOrgId((current) => current || orgResult.organizations[0]?.id || "");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof MetalError ? caught.message : "Failed to load control plane");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metal]);

  useEffect(() => {
    if (!selectedOrgId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await metal.projects.list(selectedOrgId);
        if (cancelled) {
          return;
        }
        setProjects(result.projects);
        setSelectedProjectId((current) => current || result.projects[0]?.id || "");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof MetalError ? caught.message : "Failed to load projects");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metal, selectedOrgId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    void metal.events
      .list({
        projectId: selectedProjectId,
        limit: 50,
      })
      .then((page) => {
        seen.current = new Set();
        for (const item of page.events) {
          seen.current.add(item.event_id);
          seen.current.add(`${item.event_id}:${item.cursor}`);
          cursorRef.current = item.cursor;
        }
        setEvents(page.events.slice(-20));
      })
      .catch((caught) => {
        setError(caught instanceof MetalError ? caught.message : "Event recovery failed");
      });
  }, [ingest, metal, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    let cancelled = false;
    const channelName = projectTopic(selectedProjectId);

    const recover = async () => {
      const page = await metal.events.list({
        projectId: selectedProjectId,
        after: cursorRef.current,
        limit: 50,
      });
      if (!cancelled && page.events.length > 0) {
        ingest(page.events);
      }
    };

    const channel = supabase.channel(channelName, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (payload) => {
      const body = payload.payload as EventItem | undefined;
      if (body?.event_id && body.cursor) {
        ingest([body]);
      }
    });
    channel.subscribe((nextStatus, err) => {
      if (cancelled) return;
      if (nextStatus === "SUBSCRIBED") {
        setStatus("connected");
        void recover().catch((caught) => {
          if (!cancelled) {
            setError(caught instanceof MetalError ? caught.message : "Event recovery failed");
            setStatus("error");
          }
        });
      } else if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT") {
        setStatus(err ? "error" : "reconnecting");
        setError(err?.message ?? "Realtime channel error");
      } else if (nextStatus === "CLOSED") {
        setStatus("disconnected");
      } else {
        setStatus("connecting");
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        void supabase.realtime.setAuth(session.access_token);
      }
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      void supabase.removeChannel(channel);
    };
  }, [ingest, metal, selectedProjectId, supabase]);

  async function onCreateOrganization(formData: FormData) {
    const name = String(formData.get("orgName") ?? orgName);
    const created = await metal.organizations.create(
      { name, slug: slugify(name) },
      { idempotencyKey: crypto.randomUUID() },
    );
    setOrganizations((current) => [...current, created]);
    setSelectedOrgId(created.id);
    setOrgName("");
  }

  async function onCreateProject(formData: FormData) {
    if (!selectedOrgId) return;
    const name = String(formData.get("projectName") ?? projectName);
    const created = await metal.projects.create(
      selectedOrgId,
      { name, slug: slugify(name) },
      { idempotencyKey: crypto.randomUUID() },
    );
    setProjects((current) => [...current, created]);
    setSelectedProjectId(created.id);
    setProjectName("");
    const page = await metal.events.list({ projectId: created.id, limit: 50 });
    ingest(page.events);
  }

  const latest = events.at(-1);
  const selectedOrg = organizations.find((org) => org.id === selectedOrgId);

  return (
    <div className="space-y-8">
      <section className="flex items-center justify-between rounded-2xl bg-[#181818] p-6">
        <div>
          <h1 className="text-2xl font-semibold">Control plane</h1>
          <p className="mt-2 text-sm text-[#9b9b9b]">
            Organizations, projects, and durable events.
          </p>
        </div>
        <p className="rounded-lg bg-[#1f1f1f] px-3 py-2 text-sm" data-testid="api-meta">
          API {health} · {meta || "unknown"}
        </p>
      </section>

      {error ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[#181818] px-4 py-3 text-sm"
          role="alert"
        >
          <WarningCircle size={16} />
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="rounded-2xl bg-[#181818] p-6" aria-busy="true">
          <div className="h-6 w-40 rounded bg-[#272727]" />
          <div className="mt-4 h-24 rounded bg-[#1f1f1f]" />
        </div>
      ) : null}

      <section className="grid gap-8 md:grid-cols-2">
        <form action={onCreateOrganization} className="rounded-2xl bg-[#181818] p-6">
          <h2 className="text-lg font-semibold">Create organization</h2>
          <label className="mt-4 block text-sm" htmlFor="orgName">
            Name
          </label>
          <input
            id="orgName"
            name="orgName"
            value={orgName}
            onChange={(event) => setOrgName(event.target.value)}
            className="mt-2 w-full rounded-lg bg-[#1f1f1f] px-3 py-2"
            required
          />
          <button className="mt-4 rounded-lg bg-white px-3 py-2 text-base font-semibold text-black">
            Create organization
          </button>
        </form>

        <div className="rounded-2xl bg-[#181818] p-6">
          <h2 className="text-lg font-semibold">Organization</h2>
          {organizations.length === 0 ? (
            <p className="mt-4 text-sm text-[#9b9b9b]">
              No organizations yet. Create one to start.
            </p>
          ) : (
            <select
              className="mt-4 w-full rounded-lg bg-[#1f1f1f] px-3 py-2"
              value={selectedOrgId}
              onChange={(event) => setSelectedOrgId(event.target.value)}
              data-testid="organization-selector"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          )}
          {selectedOrg ? <p className="mt-3 text-sm text-[#9b9b9b]">{selectedOrg.slug}</p> : null}
        </div>
      </section>

      <section className="grid gap-8 md:grid-cols-2">
        <form action={onCreateProject} className="rounded-2xl bg-[#181818] p-6">
          <h2 className="text-lg font-semibold">Create project</h2>
          <label className="mt-4 block text-sm" htmlFor="projectName">
            Name
          </label>
          <input
            id="projectName"
            name="projectName"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            className="mt-2 w-full rounded-lg bg-[#1f1f1f] px-3 py-2"
            required
          />
          <button
            className="mt-4 rounded-lg bg-white px-3 py-2 text-base font-semibold text-black disabled:opacity-40"
            disabled={!selectedOrgId}
          >
            Create project
          </button>
        </form>

        <div className="rounded-2xl bg-[#181818] p-6">
          <h2 className="text-lg font-semibold">Projects</h2>
          {projects.length === 0 ? (
            <p className="mt-4 text-sm text-[#9b9b9b]">No projects in this organization yet.</p>
          ) : (
            <ul className="mt-4 space-y-2" data-testid="project-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={`w-full rounded-lg px-3 py-2 text-left ${
                      selectedProjectId === project.id ? "bg-[#313131]" : "bg-[#1f1f1f]"
                    }`}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    {project.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl bg-[#181818] p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Latest project event</h2>
          <p
            className="flex items-center gap-2 text-sm text-[#9b9b9b]"
            data-testid="realtime-status"
          >
            {status === "connected" ? <PlugsConnected size={16} /> : null}
            {status === "connecting" || status === "reconnecting" ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : null}
            {status === "disconnected" || status === "error" ? <Plugs size={16} /> : null}
            {status}
          </p>
        </div>
        {!selectedProjectId ? (
          <p className="mt-4 text-sm text-[#9b9b9b]">
            Select a project to subscribe to its private channel.
          </p>
        ) : latest ? (
          <pre
            className="mt-4 overflow-x-auto rounded-lg bg-[#1f1f1f] p-4 text-sm"
            data-testid="latest-event"
          >
            {JSON.stringify(latest, null, 2)}
          </pre>
        ) : (
          <p className="mt-4 text-sm text-[#9b9b9b]" data-testid="latest-event">
            Waiting for the first durable event.
          </p>
        )}
      </section>
    </div>
  );
}
