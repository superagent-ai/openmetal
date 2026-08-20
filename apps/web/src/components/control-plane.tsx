"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  detectCursorGap,
  isDuplicateDelivery,
  parseCursor,
  parsePublicEvent,
  projectTopic,
} from "@openmetal/events";
import { MetalError } from "@openmetal/sdk";
import {
  AlertCircleIcon,
  Loading03Icon,
  Plug01Icon,
  UsbNotConnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { createMetalClient } from "@/lib/metal";

type Organization = { id: string; name: string; slug: string };
type Project = { id: string; name: string; slug: string; organization_id: string };
type EventItem = {
  cursor: string;
  event_id: string;
  type: string;
  organization_id: string;
  project_id?: string;
  occurred_at: string;
  data: Record<string, unknown>;
};
type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";

export function ControlPlane({
  organization,
  initialProjectId,
}: {
  organization: Organization;
  initialProjectId?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId ?? "");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [health, setHealth] = useState<string>("checking");
  const [meta, setMeta] = useState<string>("");
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
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
      }
      next.sort((left, right) => {
        const leftCursor = parseCursor(left.cursor);
        const rightCursor = parseCursor(right.cursor);
        return leftCursor < rightCursor ? -1 : leftCursor > rightCursor ? 1 : 0;
      });
      const retained = next.slice(-20);
      cursorRef.current = retained.at(-1)?.cursor;
      return retained;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [healthResult, metaResult] = await Promise.all([metal.health(), metal.meta()]);
        if (cancelled) {
          return;
        }
        setHealth(healthResult.status);
        setMeta(`${metaResult.name} ${metaResult.api_version}`);
        setError(null);
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
    let cancelled = false;
    void (async () => {
      try {
        const result = await metal.projects.list(organization.id);
        if (cancelled) {
          return;
        }
        setProjects(result.projects);
        setError(null);
        setSelectedProjectId((current) =>
          result.projects.some((project) => project.id === (initialProjectId ?? current))
            ? (initialProjectId ?? current)
            : result.projects.some((project) => project.id === current)
              ? current
              : (result.projects[0]?.id ?? ""),
        );
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof MetalError ? caught.message : "Failed to load projects");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialProjectId, metal, organization.id]);

  useEffect(() => {
    if (!selectedProjectId) {
      seen.current = new Set();
      cursorRef.current = undefined;
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
        setError(null);
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
      try {
        const body = parsePublicEvent(payload.payload) as EventItem;
        if (body.organization_id !== organization.id || body.project_id !== selectedProjectId) {
          return;
        }
        const previousCursor = cursorRef.current ? parseCursor(cursorRef.current) : undefined;
        const incomingCursor = parseCursor(body.cursor);
        if (previousCursor !== undefined && detectCursorGap(previousCursor, incomingCursor)) {
          void recover().catch((caught) => {
            if (!cancelled) {
              setError(caught instanceof MetalError ? caught.message : "Event recovery failed");
            }
          });
        }
        ingest([body]);
        setError(null);
      } catch {
        setError("Invalid Realtime event");
        setStatus("error");
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
  }, [ingest, metal, organization.id, selectedProjectId, supabase]);

  useEffect(() => {
    const handleProjectRenamed = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; project: Project }>).detail;
      if (detail.organizationId !== organization.id) {
        return;
      }
      setProjects((current) =>
        current.map((project) => (project.id === detail.project.id ? detail.project : project)),
      );
    };
    const handleProjectDeleted = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; projectId: string }>).detail;
      if (detail.organizationId !== organization.id) {
        return;
      }
      setProjects((current) => {
        const remaining = current.filter((project) => project.id !== detail.projectId);
        setSelectedProjectId((selected) =>
          selected === detail.projectId ? (remaining[0]?.id ?? "") : selected,
        );
        return remaining;
      });
    };
    window.addEventListener("metal:project-renamed", handleProjectRenamed);
    window.addEventListener("metal:project-deleted", handleProjectDeleted);
    return () => {
      window.removeEventListener("metal:project-renamed", handleProjectRenamed);
      window.removeEventListener("metal:project-deleted", handleProjectDeleted);
    };
  }, [organization.id]);

  const latest = events.at(-1);

  return (
    <div className="space-y-4">
      <section className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Control plane</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Projects and durable events for {organization.name}.
          </p>
        </div>
        <Badge variant="secondary" data-testid="api-meta">
          API {health} · {meta || "unknown"}
        </Badge>
      </section>

      {error ? (
        <Alert variant="destructive">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <Card aria-busy="true">
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : null}

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
          </CardHeader>
          <CardContent>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">No projects in this organization yet.</p>
            ) : (
              <ul className="space-y-2" data-testid="project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Button
                      nativeButton={false}
                      variant={selectedProjectId === project.id ? "secondary" : "ghost"}
                      className="w-full justify-start"
                      render={
                        <Link href={`/dashboard/${organization.slug}/projects/${project.slug}`} />
                      }
                    >
                      {project.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Latest project event</CardTitle>
          <CardAction>
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="realtime-status"
            >
              {status === "connected" ? (
                <HugeiconsIcon icon={Plug01Icon} strokeWidth={2} className="size-4" />
              ) : null}
              {status === "connecting" || status === "reconnecting" ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  strokeWidth={2}
                  className="size-4 animate-spin"
                />
              ) : null}
              {status === "disconnected" || status === "error" ? (
                <HugeiconsIcon icon={UsbNotConnected01Icon} strokeWidth={2} className="size-4" />
              ) : null}
              {status}
            </p>
          </CardAction>
          <span className="sr-only" data-testid="event-count">
            {events.length}
          </span>
        </CardHeader>
        <CardContent>
          {!selectedProjectId ? (
            <p className="text-sm text-muted-foreground">
              Select a project to subscribe to its private channel.
            </p>
          ) : latest ? (
            <pre
              className="overflow-x-auto rounded-lg bg-muted p-4 text-sm"
              data-testid="latest-event"
            >
              {JSON.stringify(latest, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="latest-event">
              Waiting for the first durable event.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
