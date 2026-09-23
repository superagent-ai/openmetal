import Link from "next/link";
import type { OrganizationBilling, OrganizationUsage } from "@openmetal/sdk";
import {
  Analytics01Icon,
  ApiIcon,
  ArrowRight01Icon,
  CreditCardIcon,
  Database01Icon,
  FolderCodeIcon,
  Key01Icon,
  Route02Icon,
  Settings04Icon,
  UserMultiple02Icon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
  sandboxStatusesByDate,
  summarizeSandboxStatuses,
  type DashboardSandbox,
} from "@/lib/sandbox-status";

type Organization = {
  id: string;
  name: string;
  slug: string;
};

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

const legendColors = ["bg-violet-500", "bg-blue-500", "bg-emerald-500"] as const;
const sandboxStatusStyles = {
  active: { label: "Active", dot: "bg-emerald-500" },
  stopped: { label: "Stopped", dot: "bg-blue-500" },
  failed: { label: "Failed", dot: "bg-red-500" },
} as const;
const sandboxStatuses = Object.keys(sandboxStatusStyles) as Array<keyof typeof sandboxStatusStyles>;

type ChartSegment = { value: number; color: string };
type ChartBar = { height: number; segments: ChartSegment[] };

function money(value: string): string {
  const amount = Number(value);
  const fractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

function moneyFromMicrousd(value: string): string {
  return money(String(Number(value) / 1_000_000));
}

function chartBars(stacks: ChartSegment[][]): ChartBar[] {
  const recent = stacks.slice(-8).map((segments) => ({
    segments: segments.filter((segment) => segment.value > 0),
    total: segments.reduce((sum, segment) => sum + Math.max(segment.value, 0), 0),
  }));
  const maximum = Math.max(...recent.map((bar) => bar.total), 0);
  if (maximum === 0) {
    return Array.from({ length: 8 }, () => ({ height: 8, segments: [] }));
  }
  return recent.map(({ segments, total }) => ({
    height: Math.max(10, Math.round((total / maximum) * 100)),
    segments,
  }));
}

function MetricCard({
  title,
  value,
  bars,
  items,
}: {
  title: string;
  value: string;
  bars: ChartBar[];
  items: Array<{ label: string; value: string; color?: string }>;
}) {
  return (
    <article className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <div className="mt-6 flex h-16 items-end gap-2" aria-hidden="true">
        {bars.map((bar, index) => (
          <span
            key={`${title}-${index}`}
            className={`flex flex-1 flex-col-reverse overflow-hidden rounded-sm ${
              bar.segments.length === 0 ? "bg-muted" : ""
            }`}
            style={{ height: `${bar.height}%` }}
          >
            {bar.segments.map((segment, segmentIndex) => (
              <span
                key={segmentIndex}
                className={`min-h-0.5 ${segment.color}`}
                style={{ flexGrow: segment.value }}
              />
            ))}
          </span>
        ))}
      </div>
      <dl className="mt-6 space-y-2">
        {items.length > 0 ? (
          items.slice(0, 3).map((item, index) => (
            <div key={item.label} className="flex items-center gap-2 text-xs">
              <span
                className={`size-2 rounded-full ${
                  item.color ?? legendColors[index] ?? "bg-muted-foreground/40"
                }`}
                aria-hidden="true"
              />
              <dt className="truncate text-muted-foreground">{item.label}</dt>
              <dd className="ml-auto shrink-0 font-medium tabular-nums">{item.value}</dd>
            </div>
          ))
        ) : (
          <div className="text-xs text-muted-foreground">No usage in this period</div>
        )}
      </dl>
    </article>
  );
}

export function DashboardOverview({
  organization,
  sandboxes,
  usage,
  billing,
}: {
  organization: Organization;
  sandboxes: DashboardSandbox[];
  usage: OrganizationUsage;
  billing: OrganizationBilling;
}) {
  const basePath = `/dashboard/${organization.slug}`;
  const dailySpend = usage.daily.map((day) => Number(day.total_cost.microusd) / 1_000_000);
  const sandboxCounts = summarizeSandboxStatuses(sandboxes);
  const sandboxActivity = sandboxStatusesByDate(
    sandboxes,
    usage.daily.map((day) => day.date),
  );
  const creditBarColor = billing.auto_topup.enabled ? legendColors[0] : legendColors[1];
  const creditActivity = billing.ledger.map((entry) => Math.abs(Number(entry.amount_usd)));
  const navigation = [
    {
      title: "Projects",
      description: "Create projects and manage their sandbox resources.",
      href: `${basePath}/projects`,
      icon: FolderCodeIcon,
    },
    {
      title: "API keys",
      description: "Create scoped credentials for agents and services.",
      href: `${basePath}/api-keys`,
      icon: Key01Icon,
    },
    {
      title: "BYOK",
      description: "Connect provider accounts through one unified API.",
      href: `${basePath}/providers`,
      icon: Database01Icon,
    },
    {
      title: "Usage",
      description: "Review spend and activity across every provider.",
      href: `${basePath}/usage`,
      icon: Analytics01Icon,
    },
    {
      title: "Webhooks",
      description: "Receive signed events for every resource lifecycle.",
      href: `${basePath}/webhooks`,
      icon: WebhookIcon,
    },
    {
      title: "Billing",
      description: "Fund managed compute and manage automatic top ups.",
      href: `${basePath}/billing`,
      icon: CreditCardIcon,
    },
    {
      title: "Members",
      description: "Manage access and roles across this organization.",
      href: `${basePath}/members`,
      icon: UserMultiple02Icon,
    },
    {
      title: "Settings",
      description: "Update organization details and workspace settings.",
      href: `${basePath}/settings`,
      icon: Settings04Icon,
    },
    {
      title: "API reference",
      description: "Explore schemas and test direct HTTP requests.",
      href: "/api-reference",
      icon: ApiIcon,
    },
  ] as const;

  return (
    <div className="space-y-6">
      <header>
        <div>
          <h1 className="text-2xl font-semibold">{organization.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage compute, providers, and spend from one workspace.
          </p>
        </div>
      </header>

      <section
        className="flex flex-col gap-4 rounded-xl border bg-muted/50 p-4 sm:flex-row sm:items-center"
        aria-labelledby="routing-summary-title"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background shadow-sm ring-1 ring-border">
          <HugeiconsIcon icon={Route02Icon} strokeWidth={2} className="size-4" />
        </div>
        <div>
          <h2 id="routing-summary-title" className="text-sm font-medium">
            Managed and BYOK capacity in one route
          </h2>
          <p className="text-sm text-muted-foreground">
            Match CPU, memory, region, and lifecycle requirements without provider specific code.
          </p>
        </div>
        <Button
          nativeButton={false}
          variant="outline"
          className="sm:ml-auto"
          render={<Link href={`${basePath}/providers`} />}
        >
          <HugeiconsIcon icon={Database01Icon} strokeWidth={2} data-icon="inline-start" />
          Manage providers
        </Button>
      </section>

      <section className="space-y-4 pt-6" aria-labelledby="usage-summary-title">
        <div className="flex items-center justify-between gap-4">
          <h2 id="usage-summary-title" className="text-sm font-medium">
            This week&apos;s usage
          </h2>
          <Link
            href={`${basePath}/usage`}
            className="flex items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
          >
            View activity
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard
            title="Spend this week"
            value={moneyFromMicrousd(usage.summary.total_cost.current.microusd)}
            bars={chartBars(dailySpend.map((value) => [{ value, color: legendColors[0] }]))}
            items={usage.by_provider.map((provider) => ({
              label: providerLabels[provider.provider] ?? provider.provider,
              value: moneyFromMicrousd(provider.cost.microusd),
            }))}
          />
          <MetricCard
            title="Resources"
            value={sandboxes.length.toLocaleString("en-US")}
            bars={chartBars(
              sandboxActivity.map((counts) =>
                sandboxStatuses.map((status) => ({
                  value: counts[status],
                  color: sandboxStatusStyles[status].dot,
                })),
              ),
            )}
            items={[
              {
                label: sandboxStatusStyles.active.label,
                value: sandboxCounts.active.toLocaleString("en-US"),
                color: sandboxStatusStyles.active.dot,
              },
              {
                label: sandboxStatusStyles.stopped.label,
                value: sandboxCounts.stopped.toLocaleString("en-US"),
                color: sandboxStatusStyles.stopped.dot,
              },
              {
                label: sandboxStatusStyles.failed.label,
                value: sandboxCounts.failed.toLocaleString("en-US"),
                color: sandboxStatusStyles.failed.dot,
              },
            ]}
          />
          <MetricCard
            title="Credit balance"
            value={money(billing.balance_usd)}
            bars={chartBars(creditActivity.map((value) => [{ value, color: creditBarColor }]))}
            items={[
              {
                label: "Automatic top up",
                value: billing.auto_topup.enabled ? "On" : "Off",
              },
              {
                label: "Added this month",
                value: money(billing.auto_topup.month_credited_usd),
              },
            ]}
          />
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Workspace sections">
        {navigation.map((item) => (
          <Link
            key={item.title}
            href={item.href}
            className="flex min-h-24 items-center gap-3 rounded-xl border bg-card p-4 outline-none hover:border-foreground/20 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                {item.title}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="size-3.5 text-muted-foreground"
                />
              </span>
              <span className="mt-1 block h-10 line-clamp-2 text-sm text-pretty text-muted-foreground">
                {item.description}
              </span>
            </span>
          </Link>
        ))}
      </section>
    </div>
  );
}
