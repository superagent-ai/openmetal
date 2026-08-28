import { expect, it } from "vitest";
import { CodeSandboxProvider } from "../src/index.js";

it("declares the CodeSandbox provider contract", () => {
  const provider = new CodeSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("codesandbox");
  expect(provider.capabilities.resume).toBe(true);
  expect(provider.capabilities.runtime).toEqual({
    process: {
      exec: false,
      streams: false,
      cancel: false,
      maxOutputBytes: 0,
    },
    files: {
      read: false,
      write: false,
      writeModes: [],
      createParents: false,
      list: false,
      delete: false,
      maxReadBytes: 0,
      maxWriteBytes: 0,
      maxListEntries: 0,
    },
    httpEndpoints: {
      expose: false,
      revoke: false,
    },
  });
  expect(provider.exec).toBeUndefined();
  expect(provider.cancelExec).toBeUndefined();
  expect(provider.readFile).toBeUndefined();
  expect(provider.writeFile).toBeUndefined();
  expect(provider.listFiles).toBeUndefined();
  expect(provider.deleteFile).toBeUndefined();
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
});

it("marks CodeSandbox runtime calculations as rate-card estimated", async () => {
  const provider = new CodeSandboxProvider({ apiKey: "test" });
  const startedAt = "2026-08-27T10:00:00.000Z";

  const cost = await provider.getCost({
    providerResourceId: "sandbox-1",
    providerMetadata: { startedAt },
    from: new Date(startedAt),
    to: new Date("2026-08-27T10:01:00.000Z"),
  });

  expect(cost).toMatchObject({
    amountMicrousd: 2_477n,
    provenance: "estimated_rate_card",
    confidence: "low",
    source: "codesandbox-vm-runtime-published-credit-rate",
    raw: { startedAt },
  });
});
