import { expect, it } from "vitest";
import { RunloopSandboxProvider } from "../src/index.js";

it("declares the Runloop provider contract", () => {
  const provider = new RunloopSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("runloop");
  expect(provider.capabilities.resume).toBe(true);
});
