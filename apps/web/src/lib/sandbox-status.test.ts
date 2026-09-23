import { describe, expect, it } from "vitest";
import { sandboxStatusesByDate, summarizeSandboxStatuses } from "./sandbox-status";

const createdAt = "2026-09-11T12:00:00.000Z";

describe("summarizeSandboxStatuses", () => {
  it("groups lifecycle states into active, stopped, and failed totals", () => {
    expect(
      summarizeSandboxStatuses([
        { id: "ready", state: "ready", created_at: createdAt },
        { id: "provisioning", state: "provisioning", created_at: createdAt },
        { id: "paused", state: "paused", created_at: createdAt },
        { id: "stopped", state: "stopped", created_at: createdAt },
        { id: "failed", state: "failed", created_at: createdAt },
        { id: "cleanup-failed", state: "cleanup_failed", created_at: createdAt },
      ]),
    ).toEqual({
      active: 2,
      stopped: 2,
      failed: 2,
    });
  });

  it("returns zeroes when an organization has no sandboxes", () => {
    expect(summarizeSandboxStatuses([])).toEqual({
      active: 0,
      stopped: 0,
      failed: 0,
    });
  });
});

describe("sandboxStatusesByDate", () => {
  it("groups sandbox creations on each chart date by current status", () => {
    expect(
      sandboxStatusesByDate(
        [
          { id: "one", state: "ready", created_at: "2026-09-10T23:59:00.000Z" },
          { id: "two", state: "stopped", created_at: "2026-09-11T00:01:00.000Z" },
          { id: "three", state: "provisioning", created_at: "2026-09-11T08:00:00.000Z" },
          { id: "four", state: "cleanup_failed", created_at: "2026-09-11T09:00:00.000Z" },
          { id: "outside", state: "failed", created_at: "2026-09-09T23:59:00.000Z" },
        ],
        ["2026-09-10", "2026-09-11", "2026-09-12"],
      ),
    ).toEqual([
      { active: 1, stopped: 0, failed: 0 },
      { active: 1, stopped: 1, failed: 1 },
      { active: 0, stopped: 0, failed: 0 },
    ]);
  });
});
