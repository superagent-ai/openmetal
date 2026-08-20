import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./safe-redirect";

describe("safeInternalPath", () => {
  it("preserves same-origin paths with query and hash", () => {
    expect(safeInternalPath("/dashboard/acme?tab=events#latest", "/dashboard")).toBe(
      "/dashboard/acme?tab=events#latest",
    );
  });

  it.each([
    "https://attacker.example/callback",
    "//attacker.example/callback",
    "javascript:alert(1)",
    "",
  ])("rejects unsafe redirect target %j", (target) => {
    expect(safeInternalPath(target, "/dashboard")).toBe("/dashboard");
  });
});
