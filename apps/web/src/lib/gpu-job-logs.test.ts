import type { GpuJobLogEvent } from "@openmetal/sdk";
import { describe, expect, it } from "vitest";
import { appendGpuJobLogEvents, createGpuJobLogState, gpuJobLogText } from "./gpu-job-logs";

function chunk(
  sequence: number,
  type: "stdout" | "stderr",
  bytes: Uint8Array | string,
): GpuJobLogEvent {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return {
    sequence,
    gpu_job_id: "gpj_1",
    occurred_at: "2026-09-27T10:00:00.000Z",
    type,
    data: {
      data_base64: Buffer.from(data).toString("base64"),
      byte_length: data.byteLength,
      stream_offset_bytes: 0,
    },
  };
}

describe("GPU job log accumulation", () => {
  it("merges adjacent chunks per stream and keeps interleaving", () => {
    const state = appendGpuJobLogEvents(createGpuJobLogState(), [
      chunk(1, "stdout", "epoch 1\n"),
      chunk(2, "stdout", "epoch 2\n"),
      chunk(3, "stderr", "warning\n"),
      chunk(4, "stdout", "done\n"),
    ]);
    expect(state.segments).toEqual([
      { stream: "stdout", text: "epoch 1\nepoch 2\n" },
      { stream: "stderr", text: "warning\n" },
      { stream: "stdout", text: "done\n" },
    ]);
    expect(state.lastSequence).toBe(4);
    expect(gpuJobLogText(state)).toBe("epoch 1\nepoch 2\nwarning\ndone\n");
  });

  it("decodes multi-byte characters split across batches", () => {
    const bytes = new TextEncoder().encode("loss ✓\n");
    const split = bytes.indexOf(0xe2) + 1;
    const first = appendGpuJobLogEvents(createGpuJobLogState(), [
      chunk(1, "stdout", bytes.slice(0, split)),
    ]);
    const second = appendGpuJobLogEvents(first, [chunk(2, "stdout", bytes.slice(split))]);
    expect(gpuJobLogText(second)).toBe("loss ✓\n");
  });

  it("skips replayed events and records truncation", () => {
    const first = appendGpuJobLogEvents(createGpuJobLogState(), [chunk(1, "stdout", "a")]);
    expect(appendGpuJobLogEvents(first, [chunk(1, "stdout", "a")])).toBe(first);
    const truncated = appendGpuJobLogEvents(first, [
      {
        sequence: 2,
        gpu_job_id: "gpj_1",
        occurred_at: "2026-09-27T10:00:00.000Z",
        type: "truncated",
        data: { limit_bytes: 10_485_760 },
      },
    ]);
    expect(truncated.truncatedAtBytes).toBe(10_485_760);
    expect(gpuJobLogText(truncated)).toBe("a");
  });
});
