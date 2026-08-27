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
