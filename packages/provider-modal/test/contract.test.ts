import { expect, it } from "vitest";
import { ModalSandboxProvider } from "../src/index.js";

it("declares the Modal provider contract", () => {
  const provider = new ModalSandboxProvider({ tokenId: "test", tokenSecret: "test" });
  expect(provider.name).toBe("modal");
  expect(provider.capabilities.pause).toBe(false);
});
