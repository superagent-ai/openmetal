export type DashboardSandbox = {
  created_at: string;
  id: string;
  state: string;
};

export type SandboxStatusCounts = {
  active: number;
  stopped: number;
  failed: number;
};

export function summarizeSandboxStatuses(sandboxes: DashboardSandbox[]): SandboxStatusCounts {
  const counts = { active: 0, stopped: 0, failed: 0 };
  for (const sandbox of sandboxes) {
    if (sandbox.state === "failed" || sandbox.state === "cleanup_failed") {
      counts.failed += 1;
    } else if (sandbox.state === "paused" || sandbox.state === "stopped") {
      counts.stopped += 1;
    } else {
      counts.active += 1;
    }
  }
  return counts;
}

export function sandboxCreationsByDate(sandboxes: DashboardSandbox[], dates: string[]): number[] {
  const counts = new Map(dates.map((date) => [date, 0]));
  for (const sandbox of sandboxes) {
    const date = sandbox.created_at.slice(0, 10);
    if (counts.has(date)) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return dates.map((date) => counts.get(date) ?? 0);
}
