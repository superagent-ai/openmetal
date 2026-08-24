import { expect, it } from "vitest";
import { CloudflareSandboxProvider } from "../src/index.js";

it("declares the Cloudflare provider contract", () => {
  const provider = new CloudflareSandboxProvider({
    apiKey: "test",
    apiUrl: "https://example.com",
  });
  expect(provider.name).toBe("cloudflare");
  expect(provider.capabilities.pause).toBe(false);
});
