import { describe, expect, it, vi } from "vitest";
import {
  gpuDisplayName,
  gpuJobGpuLabel,
  gpuJobHref,
  gpuJobReasonLabel,
  isGpuJobCancellable,
  listAllProjectGpuJobs,
} from "./gpu-jobs";

describe("GPU job helpers", () => {
  it("labels GPUs and requests", () => {
    expect(gpuDisplayName("nvidia-a100-80gb")).toBe("A100 80 GB");
    expect(gpuDisplayName("nvidia-future-x1")).toBe("FUTURE-X1");
    expect(gpuJobGpuLabel({ requested: { gpu: { type: "nvidia-h100", count: 2 } } } as never)).toBe(
      "2 × H100",
    );
    expect(gpuJobHref("acme", "training", "gpj_1")).toBe(
      "/dashboard/acme/projects/training/gpu-jobs/gpj_1",
    );
  });

  it("only offers cancel before a job settles", () => {
    expect(isGpuJobCancellable("running")).toBe(true);
    expect(isGpuJobCancellable("requested")).toBe(true);
    expect(isGpuJobCancellable("cancelling")).toBe(false);
    expect(isGpuJobCancellable("succeeded")).toBe(false);
  });

  it("explains state reasons", () => {
    expect(gpuJobReasonLabel("max_cost_reached")).toBe("Cancelled when its cost reached the limit");
    expect(gpuJobReasonLabel("some_new_reason")).toBe("some new reason");
    expect(gpuJobReasonLabel(null)).toBeNull();
  });

  it("follows list cursors up to the page limit", async () => {
    const listForProject = vi
      .fn()
      .mockResolvedValueOnce({ gpu_jobs: [{ id: "gpj_1" }], next_cursor: "gpj_1" })
      .mockResolvedValueOnce({ gpu_jobs: [{ id: "gpj_2" }], next_cursor: "gpj_2" })
      .mockResolvedValueOnce({ gpu_jobs: [{ id: "gpj_3" }], next_cursor: null });
    const metal = { gpuJobs: { listForProject } } as never;

    await expect(listAllProjectGpuJobs(metal, "prj_1")).resolves.toEqual({
      gpuJobs: [{ id: "gpj_1" }, { id: "gpj_2" }, { id: "gpj_3" }],
      truncated: false,
    });
    expect(listForProject).toHaveBeenLastCalledWith("prj_1", { cursor: "gpj_2", limit: 100 });

    listForProject.mockReset().mockResolvedValue({ gpu_jobs: [{ id: "gpj_x" }], next_cursor: "c" });
    await expect(listAllProjectGpuJobs(metal, "prj_1", 2)).resolves.toMatchObject({
      gpuJobs: [{ id: "gpj_x" }, { id: "gpj_x" }],
      truncated: true,
    });
  });
});
