import { expect, it } from "vitest";
import { CodeSandboxProvider } from "../src/index.js";

it("declares the CodeSandbox provider contract", () => {
  const provider = new CodeSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("codesandbox");
  expect(provider.capabilities.resume).toBe(true);
});
