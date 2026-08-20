import { describe, expect, it } from "vitest";
import { assertWebUsesSdk } from "@openmetal/testkit";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("dashboard product boundary", () => {
  it("routes product calls through the TypeScript SDK", () => {
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    expect(() => assertWebUsesSdk(webRoot)).not.toThrow();
  });
});
