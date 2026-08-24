import { expect, it } from "vitest";
import { NorthflankSandboxProvider } from "../src/index.js";

it("declares the Northflank provider contract", () => {
  const provider = new NorthflankSandboxProvider({ apiToken: "test", projectId: "test" });
  expect(provider.name).toBe("northflank");
  expect(provider.capabilities.resume).toBe(true);
});
