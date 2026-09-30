import {
  ProviderError,
  resolveProviderResources,
  type ProviderCreateSandboxInput,
  type ProviderFileWriteMode,
  type ProviderRuntimeCapabilities,
  type SandboxIsolation,
  type SandboxProvider,
} from "./index.js";

export const SANDBOX_REQUIREMENTS = [
  "source",
  "managed_billing",
  "resources",
  "isolation",
  "network.internet_access",
  "network.allow_domains",
  "network.deny_domains",
  "regions",
  "pty",
  "pause_resume",
  "public_ports",
  "process.execute",
  "process.ordered_output",
  "process.cancel",
  "filesystem.read",
  "filesystem.write",
  "filesystem.write_modes",
  "filesystem.create_parents",
  "filesystem.list",
  "filesystem.delete",
  "computer_use",
  "recording",
] as const;

export type SandboxRequirement = (typeof SANDBOX_REQUIREMENTS)[number];

export type SandboxRequirements = {
  routing: "auto" | "explicit";
  sourceKind: ProviderCreateSandboxInput["source"]["kind"];
  resources: ProviderCreateSandboxInput["resources"];
  providerOptions?: Record<string, unknown>;
  isolation?: readonly SandboxIsolation[];
  network?: {
    internetAccess?: boolean;
    allowDomains?: readonly string[];
    denyDomains?: readonly string[];
  };
  regions?: readonly string[];
  pty?: boolean;
  pauseResume?: boolean;
  publicPorts?: readonly number[];
  process?: {
    execute?: boolean;
    orderedOutput?: boolean;
    cancel?: boolean;
  };
  filesystem?: {
    read?: boolean;
    write?: boolean;
    writeModes?: readonly ProviderFileWriteMode[];
    createParents?: boolean;
    list?: boolean;
    delete?: boolean;
  };
  computerUse?: boolean;
  recordingFormat?: "mp4" | "webm";
};

export type RequirementExclusion = {
  requirement: SandboxRequirement;
  message: string;
};

export function unmetSandboxRequirements(
  provider: Pick<SandboxProvider, "name" | "capabilities">,
  requirements: SandboxRequirements,
  options: { managedBilling: boolean; runtime?: ProviderRuntimeCapabilities },
): RequirementExclusion[] {
  const { name, capabilities } = provider;
  const runtime = options.runtime ?? capabilities.runtime;
  const unmet: RequirementExclusion[] = [];
  const exclude = (requirement: SandboxRequirement, message: string) => {
    unmet.push({ requirement, message });
  };

  if (capabilities.sources && !capabilities.sources.includes(requirements.sourceKind)) {
    exclude("source", `${name} does not support ${requirements.sourceKind} sources`);
  }
  if (options.managedBilling && !capabilities.cost) {
    exclude("managed_billing", `${name} does not expose durable cost for managed billing`);
  }
  try {
    resolveProviderResources(name, requirements.resources, requirements.providerOptions);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.kind !== "unsupported") throw error;
    exclude("resources", error.message);
  }

  if (requirements.isolation?.length) {
    const claim = capabilities.isolation;
    if (!claim) {
      exclude("isolation", `${name} isolation is unknown`);
    } else if (!requirements.isolation.includes(claim.kind)) {
      exclude(
        "isolation",
        `${name} provides ${claim.kind} isolation (${claim.evidence}); requested ${requirements.isolation.join(" or ")}`,
      );
    }
  }

  const network = requirements.network;
  const policy = capabilities.network;
  if (network?.internetAccess === false && !policy?.blockInternet) {
    exclude("network.internet_access", `${name} cannot enforce blocked internet access`);
  }
  if (network?.allowDomains !== undefined && !policy?.allowDomains) {
    exclude("network.allow_domains", `${name} cannot enforce an outbound domain allow list`);
  }
  if (network?.denyDomains?.length && !policy?.denyDomains) {
    exclude("network.deny_domains", `${name} cannot enforce an outbound domain deny list`);
  }

  if (requirements.regions?.length) {
    const placement = capabilities.regions;
    if (!placement?.length) {
      exclude("regions", `${name} sandbox placement region is unknown`);
    } else if (!placement.every((region) => requirements.regions!.includes(region))) {
      exclude(
        "regions",
        `${name} may place sandboxes in ${placement.join(", ")}; requested ${requirements.regions.join(", ")}`,
      );
    }
  }

  if (requirements.pty) {
    exclude("pty", "interactive PTY sessions are not part of the OpenMetal API");
  }
  if (requirements.pauseResume && !(capabilities.pause && capabilities.resume === true)) {
    exclude("pause_resume", `${name} does not support reliable pause and resume`);
  }
  if (
    requirements.publicPorts?.length &&
    !(runtime?.httpEndpoints?.expose && runtime.httpEndpoints.revoke)
  ) {
    exclude("public_ports", `${name} does not support leased HTTP endpoints`);
  }

  const baseline = requirements.routing === "auto";
  const process = runtime?.process;
  if ((requirements.process?.execute ?? baseline) && !process?.exec) {
    exclude("process.execute", `${name} does not support process execution`);
  }
  if (requirements.process?.orderedOutput && !(process?.exec && process.streams)) {
    exclude("process.ordered_output", `${name} does not stream ordered process output`);
  }
  if (requirements.process?.cancel && !(process?.exec && process.cancel)) {
    exclude("process.cancel", `${name} does not support confirmed process cancellation`);
  }

  const files = runtime?.files;
  if ((requirements.filesystem?.read ?? baseline) && !files?.read) {
    exclude("filesystem.read", `${name} does not support file reads`);
  }
  if ((requirements.filesystem?.write ?? baseline) && !files?.write) {
    exclude("filesystem.write", `${name} does not support file writes`);
  }
  const missingModes = (requirements.filesystem?.writeModes ?? []).filter(
    (mode) => !files?.write || !files.writeModes.includes(mode),
  );
  if (missingModes.length) {
    exclude("filesystem.write_modes", `${name} does not support ${missingModes.join(", ")} writes`);
  }
  if (requirements.filesystem?.createParents && !(files?.write && files.createParents)) {
    exclude("filesystem.create_parents", `${name} does not create parent directories on write`);
  }
  if (requirements.filesystem?.list && !files?.list) {
    exclude("filesystem.list", `${name} does not support directory listing`);
  }
  if (requirements.filesystem?.delete && !files?.delete) {
    exclude("filesystem.delete", `${name} does not support file deletion`);
  }

  const computer = runtime?.computer;
  if (requirements.computerUse && !(computer?.screenshot && computer.actions.length > 0)) {
    exclude("computer_use", `${name} does not support computer use`);
  }
  if (
    requirements.recordingFormat &&
    !computer?.recording?.formats.includes(requirements.recordingFormat)
  ) {
    exclude(
      "recording",
      `${name} does not support ${requirements.recordingFormat} screen recording`,
    );
  }

  return unmet;
}
