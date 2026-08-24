import { describe, expect, it } from "vitest";
import {
  SandboxTransitionTable,
  assertSandboxTransition,
  canTransitionSandbox,
} from "../src/state-machine.js";

describe("sandbox state machine", () => {
  it("allows every declared transition", () => {
    for (const [from, targets] of Object.entries(SandboxTransitionTable)) {
      for (const to of targets) {
        expect(canTransitionSandbox(from as never, to)).toBe(true);
        expect(() => assertSandboxTransition(from as never, to)).not.toThrow();
      }
    }
  });

  it("rejects unsafe late-success transitions", () => {
    expect(canTransitionSandbox("stopped", "ready")).toBe(false);
    expect(() => assertSandboxTransition("stopped", "ready")).toThrow();
    expect(canTransitionSandbox("ready", "routing")).toBe(false);
  });
});
