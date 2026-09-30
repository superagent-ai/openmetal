import { describe, expect, it } from "vitest";
import {
  unmetSandboxRequirements,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxRequirements,
} from "../src/index.js";

const fullRuntime: NonNullable<SandboxProviderCapabilities["runtime"]> = {
  process: { exec: true, streams: true, cancel: true, maxOutputBytes: 1_024 },
  files: {
    read: true,
    write: true,
    writeModes: ["create", "overwrite", "append"],
    createParents: true,
    list: true,
    delete: true,
    maxReadBytes: 1_024,
    maxWriteBytes: 1_024,
    maxListEntries: 10,
  },
  httpEndpoints: { expose: true, revoke: true },
  computer: {
    implementation: "native",
    actions: ["mouse_click"],
    screenshot: { formats: ["png"], maxBytes: 1_024 },
    recording: { formats: ["mp4"] },
  },
};

function provider(
  capabilities: Partial<SandboxProviderCapabilities> = {},
  name: SandboxProvider["name"] = "e2b",
): Pick<SandboxProvider, "name" | "capabilities"> {
  return {
    name,
    capabilities: {
      pause: true,
      resume: true,
      cost: true,
      sources: ["environment", "oci_image"],
      runtime: fullRuntime,
      ...capabilities,
    },
  };
}

const base: SandboxRequirements = {
  routing: "explicit",
  sourceKind: "environment",
  resources: { vcpu: 1, memoryMb: 1_024, architecture: "any" },
};

function unmet(
  target: Pick<SandboxProvider, "name" | "capabilities">,
  requirements: Partial<SandboxRequirements>,
  managedBilling = true,
) {
  return unmetSandboxRequirements(target, { ...base, ...requirements }, { managedBilling }).map(
    (exclusion) => exclusion.requirement,
  );
}

describe("sandbox requirement eligibility", () => {
  it("accepts a capable provider with no requirements", () => {
    expect(unmet(provider(), {})).toEqual([]);
  });

  it("applies the portable process and filesystem baseline only to automatic routing", () => {
    const lifecycleOnly = provider({ runtime: undefined });
    expect(unmet(lifecycleOnly, {})).toEqual([]);
    expect(unmet(lifecycleOnly, { routing: "auto" })).toEqual([
      "process.execute",
      "filesystem.read",
      "filesystem.write",
    ]);
    expect(
      unmet(lifecycleOnly, {
        routing: "auto",
        process: { execute: false },
        filesystem: { read: false, write: false },
      }),
    ).toEqual([]);
  });

  it("requires every requested runtime capability", () => {
    const buffered = provider({
      runtime: {
        ...fullRuntime,
        process: { exec: true, streams: false, cancel: false, maxOutputBytes: 1_024 },
        files: {
          ...fullRuntime.files!,
          writeModes: ["overwrite"],
          createParents: false,
          list: false,
          delete: false,
        },
        httpEndpoints: { expose: false, revoke: false },
      },
    });
    expect(
      unmet(buffered, {
        process: { execute: true, orderedOutput: true, cancel: true },
        filesystem: {
          read: true,
          write: true,
          writeModes: ["overwrite", "append"],
          createParents: true,
          list: true,
          delete: true,
        },
        publicPorts: [3_000],
      }),
    ).toEqual([
      "public_ports",
      "process.ordered_output",
      "process.cancel",
      "filesystem.write_modes",
      "filesystem.create_parents",
      "filesystem.list",
      "filesystem.delete",
    ]);
  });

  it("never treats unknown isolation as satisfying a hard requirement", () => {
    expect(unmet(provider(), { isolation: ["microvm"] })).toEqual(["isolation"]);
    const microvm = provider({
      isolation: { kind: "microvm", evidence: "provider_reported", source: "https://example.com" },
    });
    expect(unmet(microvm, { isolation: ["microvm", "vm"] })).toEqual([]);
    expect(unmet(microvm, { isolation: ["container"] })).toEqual(["isolation"]);
  });

  it("fails closed on network restrictions the adapter does not enforce", () => {
    const requested = {
      network: { internetAccess: false, allowDomains: [], denyDomains: ["example.com"] },
    };
    expect(unmet(provider(), requested)).toEqual([
      "network.internet_access",
      "network.allow_domains",
      "network.deny_domains",
    ]);
    expect(unmet(provider(), { network: { internetAccess: true, denyDomains: [] } })).toEqual([]);
    const enforced = provider({
      network: {
        blockInternet: true,
        allowDomains: true,
        denyDomains: true,
        evidence: "verified",
      },
    });
    expect(unmet(enforced, requested)).toEqual([]);
  });

  it("requires every possible placement region to be acceptable", () => {
    expect(unmet(provider(), { regions: ["eu-west"] })).toEqual(["regions"]);
    expect(unmet(provider({ regions: ["eu-west"] }), { regions: ["eu-west", "eu-north"] })).toEqual(
      [],
    );
    expect(unmet(provider({ regions: ["eu-west", "us-east"] }), { regions: ["eu-west"] })).toEqual([
      "regions",
    ]);
  });

  it("rejects PTY, unsupported lifecycle, computer, source, billing, and resource requirements", () => {
    const limited = provider(
      {
        pause: false,
        resume: false,
        cost: false,
        sources: ["environment"],
        runtime: { ...fullRuntime, computer: undefined },
      },
      "runloop",
    );
    expect(
      unmet(limited, {
        sourceKind: "oci_image",
        resources: { vcpu: 64, memoryMb: 262_144, architecture: "any" },
        pty: true,
        pauseResume: true,
        computerUse: true,
        recordingFormat: "mp4",
      }),
    ).toEqual([
      "source",
      "managed_billing",
      "resources",
      "pty",
      "pause_resume",
      "computer_use",
      "recording",
    ]);
    expect(unmet(provider({ cost: false }), {}, false)).toEqual([]);
  });

  it("re-evaluates runtime requirements against discovered capabilities", () => {
    const declared = provider();
    const requirements = { ...base, computerUse: true };
    expect(unmetSandboxRequirements(declared, requirements, { managedBilling: true })).toEqual([]);
    expect(
      unmetSandboxRequirements(declared, requirements, {
        managedBilling: true,
        runtime: { ...fullRuntime, computer: undefined },
      }),
    ).toEqual([{ requirement: "computer_use", message: "e2b does not support computer use" }]);
  });
});
