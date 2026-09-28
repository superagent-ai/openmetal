"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { parsePublicEvent, projectTopic } from "@openmetal/events";
import type { GpuJob } from "@openmetal/sdk";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PauseIcon,
  Tick02Icon,
  ViewIcon,
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
import {
  gpuJobGpuLabel,
  gpuJobHref,
  isGpuJobCancellable,
  listAllProjectGpuJobs,
  TERMINAL_GPU_JOB_STATES,
} from "@/lib/gpu-jobs";
import { createMetalClient } from "@/lib/metal";
import {
  applyResourceCostUpdate,
  applyResourceTableState,
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
import { formatDuration, formatMicrousd, resourceDateFormatter } from "@/lib/resource-format";
import { statusBadgeClass } from "@/lib/status-badge";
import { createClient } from "@/lib/supabase/client";
import { useNow } from "@/lib/use-now";
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

type GpuJobRow = {
  id: string;
  type: "gpu_job";
  gpu_label: string;
  provider: GpuJob["provider"];
  cost_microusd: string | null;
  cost_updated_at: string | null;
  state: string;
  created_at: string;
  ready_at: string | null;
  paused_at: null;
  stopped_at: string | null;
};

type ResourceRow = Sandbox | GpuJobRow;

function gpuJobRow(job: GpuJob): GpuJobRow {
  return {
    id: job.id,
    type: "gpu_job",
    gpu_label: gpuJobGpuLabel(job),
    provider: job.provider,
    cost_microusd: job.cost_microusd,
    cost_updated_at: job.cost_updated_at,
    state: job.state,
    created_at: job.created_at,
    ready_at: job.started_at,
    paused_at: null,
    stopped_at: job.finished_at,
  };
}

function ProviderMark({ provider }: { provider: ResourceRow["provider"] }) {
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
  if (provider === "prime") {
    return <Image src="/providers/prime.ico" alt="" width={13} height={13} />;
  }
  if (provider === "runloop") {
    return <Image src="/providers/runloop.png" alt="" width={13} height={13} />;
  }
  return <Image src="/providers/vercel.ico" alt="" width={13} height={13} />;
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
  organizationSlug,
  projectId,
  projectSlug,
  sandboxes,
  gpuJobs,
  gpuJobsTruncated = false,
}: {
  organizationSlug: string;
  projectId: string;
  projectSlug: string;
  sandboxes: Sandbox[];
  gpuJobs: GpuJob[];
  gpuJobsTruncated?: boolean;
}) {
  const now = useNow();
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
  const [gpuJobRows, setGpuJobRows] = useState(() => gpuJobs.map(gpuJobRow));
  const [olderGpuJobsHidden, setOlderGpuJobsHidden] = useState(gpuJobsTruncated);
  const [busyResourceId, setBusyResourceId] = useState<string>();
  const [deletingSandbox, setDeletingSandbox] = useState<Sandbox>();
  const [cancellingGpuJob, setCancellingGpuJob] = useState<GpuJobRow>();
  const [error, setError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ResourceTableSort>(null);
  const [page, setPage] = useState(1);
  const parsedQuery = useMemo(() => parseResourceSearchQuery(query), [query]);
  const resourceRows = useMemo<ResourceRow[]>(
    () =>
      [...sandboxRows, ...gpuJobRows].sort(
        (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
      ),
    [gpuJobRows, sandboxRows],
  );
  const table = useMemo(
    () =>
      applyResourceTableState(resourceRows, {
        query,
        sort,
        page,
        now,
      }),
    [now, page, query, resourceRows, sort],
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

  const refreshResources = useMemo(
    () =>
      coalesceAsync(async () => {
        const [sandboxResult, jobs] = await Promise.all([
          metal.sandboxes.list(projectId),
          listAllProjectGpuJobs(metal, projectId),
        ]);
        setSandboxRows(sandboxResult.sandboxes);
        setGpuJobRows(jobs.gpuJobs.map(gpuJobRow));
        setOlderGpuJobsHidden(jobs.truncated);
        setRefreshError(undefined);
      }),
    [metal, projectId],
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void refreshResources().catch((caught) => {
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
        if (
          event.project_id !== projectId ||
          !(event.type.startsWith("sandbox.") || event.type.startsWith("gpu_job.")) ||
          cancelled
        ) {
          return;
        }
        if (event.type === "sandbox.cost_updated") {
          setSandboxRows((current) => applyResourceCostUpdate(current, event.data));
        } else if (event.type === "gpu_job.cost_updated") {
          setGpuJobRows((current) => applyResourceCostUpdate(current, event.data));
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
  }, [projectId, refreshResources, supabase]);

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
    setBusyResourceId(sandbox.id);
    try {
      updateSandbox(await metal.sandboxes.pause(projectId, sandbox.id));
      await refreshUntil(sandbox.id, ["paused", "failed"]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not pause the sandbox");
    } finally {
      setBusyResourceId(undefined);
    }
  }

  async function deleteSandbox() {
    if (!deletingSandbox) {
      return;
    }
    setError(undefined);
    setBusyResourceId(deletingSandbox.id);
    try {
      updateSandbox(await metal.sandboxes.deleteFromProject(projectId, deletingSandbox.id));
      setDeletingSandbox(undefined);
      await refreshUntil(deletingSandbox.id, ["stopped", "cleanup_failed"]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the sandbox");
    } finally {
      setBusyResourceId(undefined);
    }
  }

  async function cancelGpuJob() {
    if (!cancellingGpuJob) {
      return;
    }
    const jobId = cancellingGpuJob.id;
    setError(undefined);
    setBusyResourceId(jobId);
    try {
      const { gpu_job: updated } = await metal.gpuJobs.cancelForProject(projectId, jobId);
      setGpuJobRows((current) =>
        current.map((job) => (job.id === updated.id ? gpuJobRow(updated) : job)),
      );
      setCancellingGpuJob(undefined);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const job = await metal.gpuJobs.getForProject(projectId, jobId);
        setGpuJobRows((current) =>
          current.map((candidate) => (candidate.id === job.id ? gpuJobRow(job) : candidate)),
        );
        if (TERMINAL_GPU_JOB_STATES.has(job.state)) {
          break;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel the GPU job");
    } finally {
      setBusyResourceId(undefined);
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
        {olderGpuJobsHidden ? (
          <p className="text-sm text-muted-foreground">
            Showing the newest {gpuJobRows.length.toLocaleString("en-US")} GPU jobs. Older jobs are
            available through the API.
          </p>
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
              {resourceRows.length === 0 ? (
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
                table.rows.map((resource) => (
                  <TableRow key={resource.id}>
                    <TableCell className="pl-4">
                      {resource.type === "gpu_job" ? (
                        <Link
                          href={gpuJobHref(organizationSlug, projectSlug, resource.id)}
                          className="flex flex-col hover:underline"
                        >
                          <span>GPU job</span>
                          <span className="text-xs text-muted-foreground">
                            {resource.gpu_label}
                          </span>
                        </Link>
                      ) : (
                        "Sandbox"
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-md bg-muted">
                          <ProviderMark provider={resource.provider} />
                        </span>
                        <span className="normal-case">{providerLabel(resource.provider)}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("capitalize", statusBadgeClass(resource.state))}
                      >
                        {resource.state.replaceAll("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {resourceDateFormatter.format(new Date(resource.created_at))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {resource.ready_at
                        ? resourceDateFormatter.format(new Date(resource.ready_at))
                        : "Not started"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(
                        resource.ready_at,
                        resource.paused_at ?? resource.stopped_at,
                        now,
                      )}
                    </TableCell>
                    <TableCell
                      title={
                        resource.cost_updated_at
                          ? `Updated ${resourceDateFormatter.format(new Date(resource.cost_updated_at))}`
                          : `Waiting for ${resource.provider} usage data`
                      }
                    >
                      {formatMicrousd(resource.cost_microusd)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {resource.type === "gpu_job" ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Open actions for ${resource.id}`}
                                disabled={busyResourceId === resource.id}
                              />
                            }
                          >
                            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              render={
                                <Link
                                  href={gpuJobHref(organizationSlug, projectSlug, resource.id)}
                                />
                              }
                            >
                              <HugeiconsIcon icon={ViewIcon} strokeWidth={2} />
                              View details and logs
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={!isGpuJobCancellable(resource.state)}
                              onClick={() => setCancellingGpuJob(resource)}
                            >
                              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                              Cancel job
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Open actions for ${resource.id}`}
                                disabled={
                                  busyResourceId === resource.id || resource.state === "stopped"
                                }
                              />
                            }
                          >
                            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={
                                resource.provider === "blaxel" ||
                                resource.provider === "modal" ||
                                resource.provider === "cloudflare" ||
                                resource.provider === "vercel" ||
                                resource.state !== "ready"
                              }
                              onClick={() => void pauseSandbox(resource)}
                            >
                              <HugeiconsIcon icon={PauseIcon} strokeWidth={2} />
                              Pause
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={resource.state === "stopping"}
                              onClick={() => setDeletingSandbox(resource)}
                            >
                              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
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
            if (!open && busyResourceId !== deletingSandbox.id) {
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
              <AlertDialogCancel disabled={busyResourceId === deletingSandbox.id}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busyResourceId === deletingSandbox.id}
                onClick={() => void deleteSandbox()}
              >
                {busyResourceId === deletingSandbox.id ? "Deleting" : "Delete sandbox"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {cancellingGpuJob ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && busyResourceId !== cancellingGpuJob.id) {
              setCancellingGpuJob(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Cancel this GPU job?</AlertDialogTitle>
              <AlertDialogDescription>
                The {cancellingGpuJob.gpu_label} job stops on{" "}
                <span className="normal-case">{providerLabel(cancellingGpuJob.provider)}</span>. GPU
                time used so far is still billed, and files already written to volumes are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busyResourceId === cancellingGpuJob.id}>
                Keep running
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busyResourceId === cancellingGpuJob.id}
                onClick={() => void cancelGpuJob()}
              >
                {busyResourceId === cancellingGpuJob.id ? "Cancelling" : "Cancel job"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
