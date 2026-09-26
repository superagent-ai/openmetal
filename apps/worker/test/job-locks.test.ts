import { describe, expect, it } from "vitest";
import { JobLocks } from "../src/job-locks.js";

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("JobLocks", () => {
  it("lets shared holders on one key run together", async () => {
    const locks = new JobLocks();
    const first = locks.acquire("sandbox:a", "shared");
    const second = locks.acquire("sandbox:a", "shared");
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  it("keeps an exclusive holder alone until shared holders release", async () => {
    const locks = new JobLocks();
    const releaseShared = await locks.acquire("sandbox:a", "shared");
    const exclusive = locks.acquire("sandbox:a", "exclusive");
    expect(await settled(exclusive)).toBe(false);
    releaseShared();
    expect(await settled(exclusive)).toBe(true);
  });

  it("does not let later shared requests jump a queued exclusive request", async () => {
    const locks = new JobLocks();
    const releaseShared = await locks.acquire("sandbox:a", "shared");
    const exclusive = locks.acquire("sandbox:a", "exclusive");
    const laterShared = locks.acquire("sandbox:a", "shared");
    expect(await settled(laterShared)).toBe(false);
    releaseShared();
    const releaseExclusive = await exclusive;
    expect(await settled(laterShared)).toBe(false);
    releaseExclusive();
    expect(await settled(laterShared)).toBe(true);
  });

  it("caps shared holders at the requested limit", async () => {
    const locks = new JobLocks();
    const releaseFirst = await locks.acquire("webhook.deliver", "shared", 2);
    await locks.acquire("webhook.deliver", "shared", 2);
    const third = locks.acquire("webhook.deliver", "shared", 2);
    expect(await settled(third)).toBe(false);
    releaseFirst();
    expect(await settled(third)).toBe(true);
  });

  it("keeps different keys independent and ignores double release", async () => {
    const locks = new JobLocks();
    const release = await locks.acquire("sandbox:a", "exclusive");
    expect(await settled(locks.acquire("sandbox:b", "exclusive"))).toBe(true);
    release();
    release();
    const releaseAgain = await locks.acquire("sandbox:a", "exclusive");
    expect(await settled(locks.acquire("sandbox:a", "shared"))).toBe(false);
    releaseAgain();
  });
});
