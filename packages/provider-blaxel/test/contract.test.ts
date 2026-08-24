import { expect, it } from "vitest";
import { BlaxelSandboxProvider } from "../src/index.js";

it("declares the Blaxel provider contract", () => {
  const provider = new BlaxelSandboxProvider({ apiKey: "test", workspace: "test" });
  expect(provider.name).toBe("blaxel");
  expect(provider.capabilities.cost).toBe(true);
});
