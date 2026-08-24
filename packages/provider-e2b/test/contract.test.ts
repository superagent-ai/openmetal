import { expect, it } from "vitest";
import { E2BSandboxProvider } from "../src/index.js";

it("declares the E2B provider contract", () => {
  const provider = new E2BSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("e2b");
  expect(provider.capabilities.resume).toBe(true);
});
