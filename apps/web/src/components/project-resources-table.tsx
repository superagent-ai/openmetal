"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { parsePublicEvent, projectTopic } from "@openmetal/events";
import { Delete02Icon, MoreHorizontalIcon, PauseIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/client";

type Sandbox = {
  id: string;
  type: "sandbox";
  provider: "daytona";
  provider_cost_microusd: string | null;
  provider_cost_measured_through: string | null;
  provider_cost_updated_at: string | null;
  status: string;
  created_at: string;
  ready_at: string | null;
  paused_at: string | null;
  deleted_at: string | null;
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function subscribeToClock(onStoreChange: () => void) {
  const interval = window.setInterval(onStoreChange, 30_000);
  return () => window.clearInterval(interval);
}

function getClockSnapshot() {
  return Math.floor(Date.now() / 30_000) * 30_000;
}

function getServerClockSnapshot() {
  return 0;
}

function formatDuration(startedAt: string | null, endedAt: string | null, now: number) {
  if (!startedAt || now === 0) {
    return "Not active";
  }
  const durationMs = Math.max(
    0,
    (endedAt ? new Date(endedAt).getTime() : now) - new Date(startedAt).getTime(),
  );
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes < 1) {
    return "Less than a minute";
  }
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatMicrousd(value: string | null) {
  if (value === null) {
    return "Pending";
  }
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole.toLocaleString("en-US")}.${fraction || "00"}`;
}

export function ProjectResourcesTable({
  projectId,
  sandboxes,
}: {
  projectId: string;
  sandboxes: Sandbox[];
}) {
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const supabase = useMemo(() => createClient(), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );
  const [sandboxRows, setSandboxRows] = useState(sandboxes);
  const [busySandboxId, setBusySandboxId] = useState<string>();
  const [deletingSandbox, setDeletingSandbox] = useState<Sandbox>();
  const [error, setError] = useState<string>();

  const refreshSandboxes = useCallback(async () => {
    const result = await metal.sandboxes.list(projectId);
    setSandboxRows(result.sandboxes);
  }, [metal, projectId]);

  useEffect(() => {
    let cancelled = false;
    const channel = supabase.channel(projectTopic(projectId), {
      config: { private: true },
    });
    channel.on("broadcast", { event: "*" }, (message) => {
      try {
        const event = parsePublicEvent(message.payload);
        if (event.project_id === projectId && event.type.startsWith("sandbox.") && !cancelled) {
          void refreshSandboxes().catch((caught) => {
            if (!cancelled) {
              setError(caught instanceof Error ? caught.message : "Could not refresh resources");
            }
          });
        }
      } catch {
        // Ignore unrelated or malformed broadcasts on this project channel.
      }
    });
    channel.subscribe();

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
  }, [projectId, refreshSandboxes, supabase]);

  function updateSandbox(updated: Sandbox) {
    setSandboxRows((current) =>
      current.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
    );
  }

  async function refreshUntil(sandboxId: string, terminalStatuses: string[]) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      const result = await metal.sandboxes.list(projectId);
      setSandboxRows(result.sandboxes);
      const sandbox = result.sandboxes.find((candidate) => candidate.id === sandboxId);
      if (!sandbox || terminalStatuses.includes(sandbox.status)) {
        return;
      }
    }
  }

  async function pauseSandbox(sandbox: Sandbox) {
    setError(undefined);
    setBusySandboxId(sandbox.id);
    try {
      updateSandbox(await metal.sandboxes.pause(projectId, sandbox.id));
      await refreshUntil(sandbox.id, ["paused", "failed"]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not pause the sandbox");
    } finally {
      setBusySandboxId(undefined);
    }
  }

  async function deleteSandbox() {
    if (!deletingSandbox) {
      return;
    }
    setError(undefined);
    setBusySandboxId(deletingSandbox.id);
    try {
      updateSandbox(await metal.sandboxes.deleteFromProject(projectId, deletingSandbox.id));
      setDeletingSandbox(undefined);
      await refreshUntil(deletingSandbox.id, ["deleted", "cleanup_failed"]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the sandbox");
    } finally {
      setBusySandboxId(undefined);
    }
  }

  return (
    <>
      <div className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="pl-4">Type</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Active for</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead className="w-16 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sandboxRows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={8}
                    className="h-40 whitespace-normal text-center text-muted-foreground"
                  >
                    No resources in this project yet.
                  </TableCell>
                </TableRow>
              ) : (
                sandboxRows.map((sandbox) => (
                  <TableRow key={sandbox.id}>
                    <TableCell className="pl-4">Sandbox</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-md bg-muted">
                          <Image src="/providers/daytona.svg" alt="" width={12} height={13} />
                        </span>
                        Daytona
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {sandbox.status.replaceAll("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {dateFormatter.format(new Date(sandbox.created_at))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {sandbox.ready_at
                        ? dateFormatter.format(new Date(sandbox.ready_at))
                        : "Not started"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(
                        sandbox.ready_at,
                        sandbox.paused_at ?? sandbox.deleted_at,
                        now,
                      )}
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs"
                      title={
                        sandbox.provider_cost_updated_at
                          ? `Updated ${dateFormatter.format(
                              new Date(sandbox.provider_cost_updated_at),
                            )}`
                          : "Waiting for Daytona usage data"
                      }
                    >
                      {formatMicrousd(sandbox.provider_cost_microusd)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Open actions for ${sandbox.id}`}
                              disabled={
                                busySandboxId === sandbox.id || sandbox.status === "deleted"
                              }
                            />
                          }
                        >
                          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={sandbox.status !== "ready"}
                            onClick={() => void pauseSandbox(sandbox)}
                          >
                            <HugeiconsIcon icon={PauseIcon} strokeWidth={2} />
                            Pause
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={sandbox.status === "deleting"}
                            onClick={() => setDeletingSandbox(sandbox)}
                          >
                            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {deletingSandbox ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && busySandboxId !== deletingSandbox.id) {
              setDeletingSandbox(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete this sandbox?</AlertDialogTitle>
              <AlertDialogDescription>
                The sandbox and its filesystem will be permanently deleted from Daytona.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busySandboxId === deletingSandbox.id}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busySandboxId === deletingSandbox.id}
                onClick={() => void deleteSandbox()}
              >
                {busySandboxId === deletingSandbox.id ? "Deleting" : "Delete sandbox"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
