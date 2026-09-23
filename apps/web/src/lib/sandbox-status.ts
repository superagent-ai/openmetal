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

function sandboxStatusGroup(state: string): keyof SandboxStatusCounts {
  if (state === "failed" || state === "cleanup_failed") return "failed";
  if (state === "paused" || state === "stopped") return "stopped";
  return "active";
}

export function summarizeSandboxStatuses(sandboxes: DashboardSandbox[]): SandboxStatusCounts {
  const counts = { active: 0, stopped: 0, failed: 0 };
  for (const sandbox of sandboxes) {
    counts[sandboxStatusGroup(sandbox.state)] += 1;
  }
  return counts;
}

export function sandboxStatusesByDate(
  sandboxes: DashboardSandbox[],
  dates: string[],
): SandboxStatusCounts[] {
  const counts = new Map(dates.map((date) => [date, { active: 0, stopped: 0, failed: 0 }]));
  for (const sandbox of sandboxes) {
    const day = counts.get(sandbox.created_at.slice(0, 10));
    if (day) day[sandboxStatusGroup(sandbox.state)] += 1;
  }
  return dates.map((date) => counts.get(date) ?? { active: 0, stopped: 0, failed: 0 });
}
