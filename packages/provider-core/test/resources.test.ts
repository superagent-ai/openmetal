import { describe, expect, it } from "vitest";
import { ProviderError, resolveProviderResources } from "../src/index.js";

describe("provider resource resolution", () => {
  it("chooses the smallest satisfying Runloop size", () => {
    expect(
      resolveProviderResources("runloop", {
        vcpu: 2,
        memoryMb: 4096,
        diskMb: 8192,
        architecture: "any",
      }).providerSize,
    ).toBe("MEDIUM");
  });

  it("chooses the smallest satisfying CodeSandbox tier", () => {
    expect(
      resolveProviderResources("codesandbox", {
        vcpu: 2,
        memoryMb: 4096,
        architecture: "any",
      }).providerSize,
    ).toBe("Nano");
  });

  it("rejects unsupported resource shapes", () => {
    expect(() =>
      resolveProviderResources("runloop", {
        vcpu: 32,
        memoryMb: 131_072,
        architecture: "x86_64",
      }),
    ).toThrow(ProviderError);
  });
});
