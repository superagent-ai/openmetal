import { describe, expect, it } from "vitest";
import { resolveDisplayName, resolveInitials } from "./user-profile";

describe("user profile", () => {
  it("prefers the app display name over provider metadata", () => {
    expect(
      resolveDisplayName("ada@example.com", {
        display_name: "Ada Lovelace",
        full_name: "Augusta Ada King",
      }),
    ).toBe("Ada Lovelace");
  });

  it("uses provider metadata before the email fallback", () => {
    expect(resolveDisplayName("grace@example.com", { full_name: "Grace Hopper" })).toBe(
      "Grace Hopper",
    );
    expect(resolveDisplayName("linus@example.com", { user_name: "torvalds" })).toBe("torvalds");
  });

  it("falls back to the email local part", () => {
    expect(resolveDisplayName("margaret.hamilton@example.com")).toBe("margaret.hamilton");
    expect(resolveDisplayName("", { display_name: "   " })).toBe("Account");
  });

  it("builds consistent initials from the first two words", () => {
    expect(resolveInitials("Metal Profile Test")).toBe("MP");
    expect(resolveInitials("metal")).toBe("M");
    expect(resolveInitials("   ")).toBe("A");
  });
});
