import { expect, it } from "vitest";
import { VercelSandboxProvider } from "../src/index.js";

it("declares the Vercel provider contract", () => {
  const provider = new VercelSandboxProvider({ token: "test", projectId: "test" });
  expect(provider.name).toBe("vercel");
  expect(provider.capabilities.pause).toBe(false);
});
