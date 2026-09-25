"use client";

import Image from "next/image";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { parsePublicEvent, projectTopic } from "@openmetal/events";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PauseIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
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
  DropdownMenuCheckboxItem,
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
import { ResourceSearchInput } from "@/components/resource-search-input";
import { coalesceAsync } from "@/lib/coalesce";
import { createMetalClient } from "@/lib/metal";
import {
  applyResourceTableState,
  applySandboxCostUpdate,
  parseResourceSearchQuery,
  PENDING_PROVIDER_FILTER,
  providerLabel,
  resourceSearchQualifiers,
  serializeResourceSearchQuery,
  statusLabel,
  toggleSearchQualifier,
  type ResourceTableSort,
  type ResourceTableSortColumn,
} from "@/lib/resource-table";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Sandbox = {
  id: string;
  type: "sandbox";
  provider:
    | "blaxel"
    | "cloudflare"
    | "codesandbox"
    | "daytona"
    | "e2b"
    | "freestyle"
    | "modal"
    | "northflank"
    | "prime"
    | "runloop"
    | "vercel"
    | null;
  cost_microusd: string | null;
  cost_updated_at: string | null;
  state: string;
  created_at: string;
  ready_at: string | null;
  paused_at: string | null;
  stopped_at: string | null;
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

function ProviderMark({ provider }: { provider: Sandbox["provider"] }) {
  if (!provider) {
    return null;
  }
  if (provider === "blaxel") {
    return <Image src="/providers/blaxel.png" alt="" width={13} height={13} />;
  }
  if (provider === "cloudflare") {
    return <Image src="/providers/cloudflare.ico" alt="" width={13} height={13} />;
  }
  if (provider === "codesandbox") {
    return <Image src="/providers/codesandbox.svg" alt="" width={13} height={13} />;
  }
  if (provider === "daytona") {
    return <Image src="/providers/daytona.svg" alt="" width={12} height={13} />;
  }
  if (provider === "e2b") {
    return <Image src="/providers/e2b.png" alt="" width={13} height={13} />;
  }
  if (provider === "modal") {
    return <Image src="/providers/modal.svg" alt="" width={13} height={13} />;
  }
  if (provider === "northflank") {
    return <Image src="/providers/northflank.svg" alt="" width={13} height={9} />;
  }
  if (provider === "runloop") {
    return <Image src="/providers/runloop.png" alt="" width={13} height={13} />;
  }
  return <Image src="/providers/vercel.ico" alt="" width={13} height={13} />;
}

function statusBadgeClass(status: string) {
  if (status === "ready") {
    return "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300";
  }
  if (status === "requested" || status === "provisioning") {
    return "bg-sky-500/15 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300";
  }
  if (status === "pausing" || status === "stopping" || status === "cleanup_pending") {
    return "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300";
  }
  if (status === "failed" || status === "cleanup_failed") {
    return "bg-destructive/10 text-destructive dark:bg-destructive/20";
  }
  if (status === "provision_unknown") {
    return "bg-violet-500/15 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300";
  }
  return "bg-muted text-muted-foreground";
}

function sortAria(sort: ResourceTableSort, column: ResourceTableSortColumn) {
  if (sort?.column !== column) {
    return "none";
  }
  return sort.direction === "asc" ? "ascending" : "descending";
}

function ColumnHeaderMenu({
  label,
  column,
  sort,
  onSort,
  filter,
}: {
  label: string;
  column: ResourceTableSortColumn;
  sort: ResourceTableSort;
  onSort: (column: ResourceTableSortColumn, direction: "asc" | "desc") => void;
  filter?: {
    options: { value: string; label: string; count: number }[];
    selected: string[];
    onToggle: (value: string) => void;
    onClear: () => void;
  };
}) {
  const active = sort?.column === column;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Open ${label} column menu`}
            className="-ml-2 h-7 px-2 text-sm font-medium text-foreground"
          />
        }
      >
        {label}
        {active ? (
          <HugeiconsIcon
            icon={sort?.direction === "asc" ? ArrowUp01Icon : ArrowDown01Icon}
            strokeWidth={2}
          />
        ) : (
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onClick={() => onSort(column, "asc")}>
          <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
          Sort ascending
          {active && sort?.direction === "asc" ? (
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="ml-auto" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSort(column, "desc")}>
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
          Sort descending
          {active && sort?.direction === "desc" ? (
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="ml-auto" />
          ) : null}
        </DropdownMenuItem>
        {filter ? (
          <>
            <DropdownMenuSeparator />
            {filter.options.length === 0 ? (
              <DropdownMenuItem disabled>No values</DropdownMenuItem>
            ) : (
              filter.options.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={filter.selected.includes(option.value)}
                  aria-label={`${option.label}, ${option.count}`}
                  onCheckedChange={() => filter.onToggle(option.value)}
                >
                  <span className="capitalize">{option.label}</span>
                  <span className="ml-auto mr-6 text-xs text-muted-foreground tabular-nums">
                    {option.count}
                  </span>
                </DropdownMenuCheckboxItem>
              ))
            )}
            {filter.selected.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={filter.onClear}>Clear filters</DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectResourcesTable({
  projectId,
  sandboxes,
}: {
  projectId: string;
  sandboxes: Sandbox[];
}) {
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const supabase = useMemo(() => createClient({ isSingleton: false }), []);
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
  const [refreshError, setRefreshError] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ResourceTableSort>(null);
  const [page, setPage] = useState(1);
  const parsedQuery = useMemo(() => parseResourceSearchQuery(query), [query]);
  const table = useMemo(
    () =>
      applyResourceTableState(sandboxRows, {
        query,
        sort,
        page,
        now,
      }),
    [now, page, query, sandboxRows, sort],
  );
  const providerOptions = useMemo(
    () =>
      [...table.providerFacets.entries()]
        .map(([value, count]) => ({
          value,
          count,
          label: providerLabel(value === PENDING_PROVIDER_FILTER ? null : value),
        }))
        .sort((left, right) => left.label.localeCompare(right.label, "en")),
    [table.providerFacets],
  );
  const statusOptions = useMemo(
    () =>
      [...table.statusFacets.entries()]
        .map(([value, count]) => ({
          value,
          count,
          label: statusLabel(value),
        }))
        .sort((left, right) => left.label.localeCompare(right.label, "en")),
    [table.statusFacets],
  );
  const searchQualifiers = useMemo(
    () =>
      resourceSearchQualifiers({
        extraProviders: providerOptions,
        extraStatuses: statusOptions,
      }),
    [providerOptions, statusOptions],
  );

  function updateQuery(next: string) {
    setQuery(next);
    setPage(1);
  }

  function toggleQualifier(qualifier: "provider" | "status", value: string) {
    updateQuery(toggleSearchQualifier(query, qualifier, value));
  }

  function clearQualifier(qualifier: "provider" | "status") {
    const next = parseResourceSearchQuery(query);
    next[qualifier === "provider" ? "providers" : "statuses"] = [];
    updateQuery(serializeResourceSearchQuery(next));
  }

  function clearFilters() {
    setQuery("");
    setPage(1);
  }

  function updateSort(column: ResourceTableSortColumn, direction: "asc" | "desc") {
    setSort({ column, direction });
    setPage(1);
  }

  const refreshSandboxes = useMemo(
    () =>
      coalesceAsync(async () => {
        const result = await metal.sandboxes.list(projectId);
        setSandboxRows(result.sandboxes);
        setRefreshError(undefined);
      }),
    [metal, projectId],
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void refreshSandboxes().catch((caught) => {
        if (!cancelled) {
          setRefreshError(caught instanceof Error ? caught.message : "Could not refresh resources");
        }
      });
    };
    const channel = supabase.channel(projectTopic(projectId), {
      config: { private: true },
    });
    channel.on("broadcast", { event: "*" }, (message) => {
      try {
        const event = parsePublicEvent(message.payload);
        if (event.project_id !== projectId || !event.type.startsWith("sandbox.") || cancelled) {
          return;
        }
        if (event.type === "sandbox.cost_updated") {
          setSandboxRows((current) => applySandboxCostUpdate(current, event.data));
        } else {
          refresh();
        }
      } catch {
        // Ignore unrelated or malformed broadcasts on this project channel.
      }
    });
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        await supabase.realtime.setAuth(data.session.access_token);
      }
      if (!cancelled) {
        channel.subscribe((status) => {
          if (!cancelled && status === "SUBSCRIBED") {
            refresh();
          } else if (!cancelled && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
            setRefreshError("Realtime resource updates disconnected");
          }
        });
      }
    })();

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
      if (!sandbox || terminalStatuses.includes(sandbox.state)) {
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
      await refreshUntil(deletingSandbox.id, ["stopped", "cleanup_failed"]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the sandbox");
    } finally {
      setBusySandboxId(undefined);
    }
  }

  return (
    <>
      <div className="space-y-3">
        {error || refreshError ? (
          <Alert variant="destructive">
            <AlertDescription>{error ?? refreshError}</AlertDescription>
          </Alert>
        ) : null}
        <ResourceSearchInput
          query={query}
          onQueryChange={updateQuery}
          qualifiers={searchQualifiers}
        />
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="pl-4">Type</TableHead>
                <TableHead aria-sort={sortAria(sort, "provider")}>
                  <ColumnHeaderMenu
                    label="Provider"
                    column="provider"
                    sort={sort}
                    onSort={updateSort}
                    filter={{
                      options: providerOptions,
                      selected: parsedQuery.providers,
                      onToggle: (value) => toggleQualifier("provider", value),
                      onClear: () => clearQualifier("provider"),
                    }}
                  />
                </TableHead>
                <TableHead aria-sort={sortAria(sort, "status")}>
                  <ColumnHeaderMenu
                    label="Status"
                    column="status"
                    sort={sort}
                    onSort={updateSort}
                    filter={{
                      options: statusOptions,
                      selected: parsedQuery.statuses,
                      onToggle: (value) => toggleQualifier("status", value),
                      onClear: () => clearQualifier("status"),
                    }}
                  />
                </TableHead>
                <TableHead aria-sort={sortAria(sort, "created")}>
                  <ColumnHeaderMenu
                    label="Created"
                    column="created"
                    sort={sort}
                    onSort={updateSort}
                  />
                </TableHead>
                <TableHead aria-sort={sortAria(sort, "started")}>
                  <ColumnHeaderMenu
                    label="Started"
                    column="started"
                    sort={sort}
                    onSort={updateSort}
                  />
                </TableHead>
                <TableHead aria-sort={sortAria(sort, "activeFor")}>
                  <ColumnHeaderMenu
                    label="Active for"
                    column="activeFor"
                    sort={sort}
                    onSort={updateSort}
                  />
                </TableHead>
                <TableHead aria-sort={sortAria(sort, "cost")}>
                  <ColumnHeaderMenu label="Cost" column="cost" sort={sort} onSort={updateSort} />
                </TableHead>
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
              ) : table.total === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="h-40 whitespace-normal text-center">
                    <div className="flex flex-col items-center gap-2">
                      <p className="text-muted-foreground">No resources match these filters</p>
                      <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                table.rows.map((sandbox) => (
                  <TableRow key={sandbox.id}>
                    <TableCell className="pl-4">Sandbox</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-md bg-muted">
                          <ProviderMark provider={sandbox.provider} />
                        </span>
                        <span className="normal-case">{providerLabel(sandbox.provider)}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("capitalize", statusBadgeClass(sandbox.state))}
                      >
                        {sandbox.state.replaceAll("_", " ")}
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
                        sandbox.paused_at ?? sandbox.stopped_at,
                        now,
                      )}
                    </TableCell>
                    <TableCell
                      title={
                        sandbox.cost_updated_at
                          ? `Updated ${dateFormatter.format(new Date(sandbox.cost_updated_at))}`
                          : `Waiting for ${sandbox.provider} usage data`
                      }
                    >
                      {formatMicrousd(sandbox.cost_microusd)}
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
                              disabled={busySandboxId === sandbox.id || sandbox.state === "stopped"}
                            />
                          }
                        >
                          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={
                              sandbox.provider === "blaxel" ||
                              sandbox.provider === "modal" ||
                              sandbox.provider === "cloudflare" ||
                              sandbox.provider === "vercel" ||
                              sandbox.state !== "ready"
                            }
                            onClick={() => void pauseSandbox(sandbox)}
                          >
                            <HugeiconsIcon icon={PauseIcon} strokeWidth={2} />
                            Pause
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={sandbox.state === "stopping"}
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
          {table.total > table.pageSize ? (
            <div className="flex items-center justify-between border-t px-4 py-2">
              <p className="text-sm text-muted-foreground">
                {table.from}–{table.to} of {table.total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={table.page <= 1}
                  onClick={() => setPage(table.page - 1)}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={table.page >= table.pageCount}
                  onClick={() => setPage(table.page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
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
                The sandbox and its filesystem will be permanently deleted from{" "}
                <span className="normal-case">
                  {providerLabel(deletingSandbox.provider)}
                  {"."}
                </span>
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
