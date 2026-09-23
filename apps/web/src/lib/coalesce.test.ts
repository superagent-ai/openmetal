import { describe, expect, it } from "vitest";
import { coalesceAsync } from "./coalesce";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("coalesceAsync", () => {
  it("runs once per burst plus one trailing run", async () => {
    const runs: ReturnType<typeof deferred>[] = [];
    const trigger = coalesceAsync(() => {
      const run = deferred();
      runs.push(run);
      return run.promise;
    });

    const first = trigger();
    const burst = Array.from({ length: 50 }, () => trigger());
    expect(runs).toHaveLength(1);

    runs[0]!.resolve();
    await first;
    await Promise.resolve();
    expect(runs).toHaveLength(2);

    runs[1]!.resolve();
    await Promise.all(burst);
    expect(runs).toHaveLength(2);
  });

  it("starts the trailing run after a failed run and reports each failure", async () => {
    const runs: ReturnType<typeof deferred>[] = [];
    const trigger = coalesceAsync(() => {
      const run = deferred();
      runs.push(run);
      return run.promise;
    });

    const first = trigger();
    const trailing = trigger();
    runs[0]!.reject(new Error("request timed out"));
    await expect(first).rejects.toThrow("request timed out");
    await Promise.resolve();
    expect(runs).toHaveLength(2);

    runs[1]!.resolve();
    await expect(trailing).resolves.toBeUndefined();
  });

  it("starts a fresh run once the previous one settled", async () => {
    let count = 0;
    const trigger = coalesceAsync(async () => {
      count += 1;
    });

    await trigger();
    await trigger();
    expect(count).toBe(2);
  });
});
