import type { SandboxState } from "@openmetal/contracts";

const transitions: Record<SandboxState, ReadonlySet<SandboxState>> = {
  requested: new Set(["routing", "stopping"]),
  routing: new Set(["provisioning", "failed", "stopping"]),
  provisioning: new Set(["ready", "provision_unknown", "routing", "failed", "stopping"]),
  provision_unknown: new Set(["ready", "routing", "failed", "cleanup_pending", "stopping"]),
  ready: new Set(["pausing", "stopping", "runtime_unknown"]),
  pausing: new Set(["paused", "ready", "runtime_unknown", "stopping"]),
  paused: new Set(["resuming", "stopping"]),
  resuming: new Set(["ready", "paused", "runtime_unknown", "stopping"]),
  runtime_unknown: new Set(["ready", "paused", "cleanup_pending", "stopping", "failed"]),
  stopping: new Set(["stopped", "cleanup_pending", "cleanup_failed"]),
  cleanup_pending: new Set(["stopped", "cleanup_failed"]),
  cleanup_failed: new Set(["cleanup_pending", "stopping"]),
  stopped: new Set(),
  failed: new Set(["stopping", "cleanup_pending", "stopped"]),
};

export function canTransitionSandbox(from: SandboxState, to: SandboxState): boolean {
  return from === to || transitions[from].has(to);
}

export function assertSandboxTransition(from: SandboxState, to: SandboxState): void {
  if (!canTransitionSandbox(from, to)) {
    throw new Error(`invalid sandbox transition: ${from} -> ${to}`);
  }
}

export const SandboxTransitionTable = transitions;
