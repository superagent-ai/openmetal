import { expect, it } from "vitest";
import { DaytonaSandboxProvider } from "../src/index.js";

it("declares the Daytona provider contract", () => {
  const provider = new DaytonaSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("daytona");
  expect(provider.capabilities.pause).toBe(false);
});
