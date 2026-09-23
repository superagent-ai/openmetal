"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
  ArrowDown01Icon,
  Calendar03Icon,
  FilterHorizontalIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { OrganizationUsage } from "@openmetal/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { paginateItems } from "@/lib/pagination";
import type { UsageFilters, UsageRange } from "@/lib/usage-filters";

type ProjectOption = {
  id: string;
  name: string;
  slug: string;
};

type UsageTab = "activity" | "providers" | "projects";

const providerLabels: Record<string, string> = {
  blaxel: "Blaxel",
  cloudflare: "Cloudflare",
  codesandbox: "CodeSandbox",
  daytona: "Daytona",
  e2b: "E2B",
  freestyle: "Freestyle",
  modal: "Modal",
  northflank: "Northflank",
  runloop: "Runloop",
  vercel: "Vercel",
};

const providerLogos: Record<string, { src: string; invert?: boolean }> = {
  blaxel: { src: "/providers/blaxel.png" },
  cloudflare: { src: "/providers/cloudflare.ico" },
  codesandbox: { src: "/providers/codesandbox.svg", invert: true },
  daytona: { src: "/providers/daytona.svg" },
  e2b: { src: "/providers/e2b.png", invert: true },
  freestyle: { src: "/providers/freestyle.png" },
  modal: { src: "/providers/modal.svg" },
  northflank: { src: "/providers/northflank.svg" },
  runloop: { src: "/providers/runloop.png" },
  vercel: { src: "/providers/vercel.ico", invert: true },
};

const rollingRanges: Array<{ value: UsageRange; label: string; shortcut: string }> = [
  { value: "15m", label: "Past 15 minutes", shortcut: "15m" },
  { value: "30m", label: "Past 30 minutes", shortcut: "30m" },
  { value: "1h", label: "Past 1 hour", shortcut: "1h" },
  { value: "3h", label: "Past 3 hours", shortcut: "3h" },
  { value: "24h", label: "Past 24 hours", shortcut: "1d" },
  { value: "48h", label: "Past 48 hours", shortcut: "2d" },
  { value: "7d", label: "Past 1 week", shortcut: "1w" },
  { value: "30d", label: "Past 1 month", shortcut: "1mo" },
  { value: "1y", label: "Past 1 year", shortcut: "1y" },
];

const calendarRanges: Array<{ value: UsageRange; label: string; shortcut: string }> = [
  { value: "today", label: "Today", shortcut: "Today" },
  { value: "yesterday", label: "Yesterday", shortcut: "Yesterday" },
  { value: "this_week", label: "This week", shortcut: "This week" },
  { value: "prev_week", label: "Previous week", shortcut: "Prev week" },
  { value: "this_month", label: "This month", shortcut: "This month" },
  { value: "prev_month", label: "Previous month", shortcut: "Prev month" },
  { value: "this_year", label: "This year", shortcut: "This year" },
  { value: "prev_year", label: "Previous year", shortcut: "Prev year" },
];

const rangeOptions = [
  ...rollingRanges,
  ...calendarRanges,
  { value: "live" as const, label: "Live", shortcut: "Live" },
];

const chartConfig = {
  cost: {
    label: "Cost",
    color: "#8b5cf6",
  },
} satisfies ChartConfig;

const ACTIVITY_PAGE_SIZE = 20;

function usd(value: { microusd: string }): number {
  return Number(value.microusd) / 1_000_000;
}

function money(value: { microusd: string }): string {
  const amount = usd(value);
  const fractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

function chartMoney(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(3)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(0)}`;
}

function ProviderName({ provider }: { provider: string }) {
  const logo = providerLogos[provider];
  return (
    <span className="flex items-center gap-2">
      {logo ? (
        <Image
          src={logo.src}
          alt=""
          width={16}
          height={16}
          className={`size-4 object-contain ${logo.invert ? "dark:invert" : ""}`}
        />
      ) : null}
      <span>{providerLabels[provider] ?? provider}</span>
    </span>
  );
}

function rangeButtonLabel(usage: OrganizationUsage, range: UsageRange): string {
  const option = rangeOptions.find((item) => item.value === range);
  const formatter = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${option?.shortcut ?? "1d"}  ${formatter.format(new Date(usage.period.from))} – ${formatter.format(
    new Date(usage.period.through),
  )}`;
}

function activityDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function histogram(
  activity: OrganizationUsage["activity"],
  from: string,
  through: string,
): Array<{ timestamp: number; label: string; cost: number }> {
  const start = new Date(from).getTime();
  const end = new Date(through).getTime();
  const bucketCount = 32;
  const duration = Math.max(end - start, 1);
  const bucketSize = duration / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    timestamp: start + index * bucketSize,
    label: "",
    cost: 0,
  }));
  for (const item of activity) {
    const timestamp = new Date(item.measured_through).getTime();
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((timestamp - start) / bucketSize)),
    );
    buckets[index]!.cost += usd(item.cost_delta);
  }
  const labelFormatter = new Intl.DateTimeFormat("en", {
    month: duration > 7 * 24 * 60 * 60 * 1_000 ? "short" : undefined,
    day: duration > 48 * 60 * 60 * 1_000 ? "numeric" : undefined,
    hour: duration <= 7 * 24 * 60 * 60 * 1_000 ? "numeric" : undefined,
    minute: duration <= 48 * 60 * 60 * 1_000 ? "2-digit" : undefined,
  });
  return buckets.map((bucket) => ({
    ...bucket,
    label: labelFormatter.format(new Date(bucket.timestamp)),
  }));
}

function FilterSubmenu({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: ReactNode }>;
  onSelect: (value: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>{label}</span>
          {value !== "all" ? (
            <span className="text-xs tabular-nums text-muted-foreground">1</span>
          ) : null}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-52">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            className={value === option.value ? "bg-accent text-accent-foreground" : undefined}
            onClick={() =>
              onSelect(value === option.value && option.value !== "all" ? "all" : option.value)
            }
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ActivityTable({ activity }: { activity: OrganizationUsage["activity"] }) {
  const [page, setPage] = useState(1);
  const paged = paginateItems(activity, page, ACTIVITY_PAGE_SIZE);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead>Total cost</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.total === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-40 text-center text-muted-foreground">
                  No cost activity matches the selected range and filters.
                </TableCell>
              </TableRow>
            ) : (
              paged.rows.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {activityDate(item.measured_through)}
                  </TableCell>
                  <TableCell>
                    <ProviderName provider={item.provider} />
                  </TableCell>
                  <TableCell>{item.project_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {item.billing_mode === "byok" ? "BYOK" : "Managed"}
                    </Badge>
                  </TableCell>
                  <TableCell>{money(item.cumulative_cost)}</TableCell>
                  <TableCell className="capitalize">{item.status.replaceAll("_", " ")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t px-4 py-2">
        <p className="text-sm text-muted-foreground">
          {paged.total === 0
            ? "No cost snapshots"
            : `Showing ${paged.from}–${paged.to} of the latest ${paged.total} cost snapshots`}
        </p>
        {paged.total > paged.pageSize ? (
          <div
            className="flex items-center gap-2"
            role="navigation"
            aria-label="Cost activity pages"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={paged.page <= 1}
              onClick={() => setPage(paged.page - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={paged.page >= paged.pageCount}
              onClick={() => setPage(paged.page + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function UsageView({
  organizationSlug,
  usage,
  projects,
  filters,
}: {
  organizationSlug: string;
  usage: OrganizationUsage;
  projects: ProjectOption[];
  filters: UsageFilters;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<UsageTab>("activity");
  const chartData = useMemo(
    () => histogram(usage.activity, usage.period.from, usage.period.through),
    [usage.activity, usage.period.from, usage.period.through],
  );
  const activeFilterCount = [
    "project_id",
    "provider",
    "billing_mode",
    "status",
    "cost_provenance",
  ].filter((key) => searchParams.has(key)).length;

  function updateFilter(key: string, value: string, defaultValue = "all") {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === defaultValue) next.delete(key);
    else next.set(key, value);
    startTransition(() => {
      router.push(`${pathname}${next.size ? `?${next.toString()}` : ""}`, { scroll: false });
    });
  }

  function clearFilters() {
    const next = new URLSearchParams(searchParams.toString());
    for (const key of ["project_id", "provider", "billing_mode", "status", "cost_provenance"]) {
      next.delete(key);
    }
    startTransition(() => {
      router.push(`${pathname}${next.size ? `?${next.toString()}` : ""}`, { scroll: false });
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Inspect provider cost activity across the organization.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh usage"
            onClick={() => startTransition(() => router.refresh())}
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              strokeWidth={2}
              className={pending ? "animate-spin" : undefined}
            />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="outline" aria-label="Filter usage activity" />}
            >
              <HugeiconsIcon icon={FilterHorizontalIcon} strokeWidth={2} />
              Filters
              {activeFilterCount > 0 ? (
                <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1 tabular-nums">
                  {activeFilterCount}
                </Badge>
              ) : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Filter activity</DropdownMenuLabel>
                <FilterSubmenu
                  label="Project"
                  value={filters.projectId ?? "all"}
                  options={[
                    { value: "all", label: "All projects" },
                    ...projects.map((project) => ({ value: project.id, label: project.name })),
                  ]}
                  onSelect={(value) => updateFilter("project_id", value)}
                />
                <FilterSubmenu
                  label="Provider"
                  value={filters.provider ?? "all"}
                  options={[
                    { value: "all", label: "All providers" },
                    ...Object.keys(providerLabels).map((value) => ({
                      value,
                      label: <ProviderName provider={value} />,
                    })),
                  ]}
                  onSelect={(value) => updateFilter("provider", value)}
                />
                <FilterSubmenu
                  label="Billing"
                  value={filters.billingMode}
                  options={[
                    { value: "all", label: "All billing modes" },
                    { value: "managed", label: "Managed" },
                    { value: "byok", label: "BYOK" },
                  ]}
                  onSelect={(value) => updateFilter("billing_mode", value)}
                />
                <FilterSubmenu
                  label="Cost source"
                  value={filters.costProvenance ?? "all"}
                  options={[
                    { value: "all", label: "All cost sources" },
                    { value: "provider_reported", label: "Provider reported" },
                    { value: "provider_metered", label: "Provider metered" },
                    { value: "estimated_rate_card", label: "Rate estimate" },
                    { value: "unknown", label: "Unknown" },
                  ]}
                  onSelect={(value) => updateFilter("cost_provenance", value)}
                />
                <FilterSubmenu
                  label="Status"
                  value={filters.status ?? "all"}
                  options={[
                    { value: "all", label: "All statuses" },
                    { value: "ready", label: "Ready" },
                    { value: "paused", label: "Paused" },
                    { value: "stopped", label: "Stopped" },
                    { value: "failed", label: "Failed" },
                  ]}
                  onSelect={(value) => updateFilter("status", value)}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={activeFilterCount === 0} onClick={clearFilters}>
                  Clear all filters
                  {activeFilterCount > 0 ? (
                    <DropdownMenuShortcut>{activeFilterCount}</DropdownMenuShortcut>
                  ) : null}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="outline" className="min-w-56 justify-between" />
              }
            >
              <span className="truncate">{rangeButtonLabel(usage, filters.range)}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70vh] min-w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Rolling range</DropdownMenuLabel>
                {rollingRanges.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    className={
                      filters.range === option.value
                        ? "bg-accent text-accent-foreground"
                        : undefined
                    }
                    onClick={() => updateFilter("range", option.value, "24h")}
                  >
                    {option.label}
                    <DropdownMenuShortcut>{option.shortcut}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Calendar range</DropdownMenuLabel>
                {calendarRanges.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    className={
                      filters.range === option.value
                        ? "bg-accent text-accent-foreground"
                        : undefined
                    }
                    onClick={() => updateFilter("range", option.value, "24h")}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={
                  filters.range === "live" ? "bg-accent text-accent-foreground" : undefined
                }
                onClick={() => updateFilter("range", "live", "24h")}
              >
                <span className="size-2 rounded-full bg-emerald-500" />
                Live
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex gap-6 border-b">
        {(["activity", "providers", "projects"] as UsageTab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`relative pb-2 text-sm capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              tab === value ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {value}
            {tab === value ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-foreground" />
            ) : null}
          </button>
        ))}
      </div>

      {tab === "activity" ? (
        <div className="overflow-hidden rounded-xl border">
          <div className="border-b p-4">
            <ChartContainer config={chartConfig} className="h-44 w-full aspect-auto">
              <BarChart data={chartData} accessibilityLayer margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={64}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickCount={4}
                  width={56}
                  domain={[0, "auto"]}
                  tickFormatter={(value) => chartMoney(Number(value))}
                />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.45 }}
                  content={
                    <ChartTooltipContent
                      className="min-w-44 gap-2 px-3 py-2"
                      formatter={(value) => (
                        <div className="flex w-full items-center justify-between gap-6">
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <span
                              className="size-2 rounded-[2px]"
                              style={{ backgroundColor: "var(--color-cost)" }}
                            />
                            Cost
                          </span>
                          <span className="font-mono font-medium tabular-nums">
                            {chartMoney(Number(value))}
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                <Bar dataKey="cost" fill="var(--color-cost)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </div>
          <ActivityTable
            key={[
              filters.range,
              filters.projectId ?? "",
              filters.provider ?? "",
              filters.billingMode,
              filters.status ?? "",
              filters.costProvenance ?? "",
              usage.period.from,
              usage.period.through,
            ].join("\0")}
            activity={usage.activity}
          />
        </div>
      ) : null}

      {tab === "providers" ? (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Managed</TableHead>
                <TableHead className="text-right">BYOK</TableHead>
                <TableHead className="text-right">Provider reported</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.by_provider.map((item) => (
                <TableRow key={item.provider}>
                  <TableCell className="font-medium">
                    <ProviderName provider={item.provider} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(item.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.share_percent.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(item.managed_cost)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(item.byok_cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.reported_percent.toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {tab === "projects" ? (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Managed</TableHead>
                <TableHead className="text-right">BYOK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.by_project.map((item) => (
                <TableRow key={item.project_id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/${organizationSlug}/projects/${item.project_slug}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {item.project_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(item.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.share_percent.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(item.managed_cost)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(item.byok_cost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-3.5" />
        All timestamps use the browser locale. Provider reported cost can lag the final invoice.
      </div>
    </div>
  );
}
