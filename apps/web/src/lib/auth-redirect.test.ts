import { describe, expect, it } from "vitest";
import { loginErrorPath, postAuthPath, withNextParam } from "./auth-redirect";

describe("postAuthPath", () => {
  it("defaults to the dashboard", () => {
    expect(postAuthPath(undefined)).toBe("/dashboard");
    expect(postAuthPath("")).toBe("/dashboard");
  });

  it("keeps a safe internal next path", () => {
    expect(postAuthPath("/dashboard/acme/projects")).toBe("/dashboard/acme/projects");
  });
});

describe("loginErrorPath", () => {
  it("encodes the error message", () => {
    expect(loginErrorPath("Sign in failed")).toBe("/login?error=Sign+in+failed");
  });

  it("preserves next when it is not the default", () => {
    expect(loginErrorPath("Denied", "/dashboard/acme")).toBe(
      "/login?error=Denied&next=%2Fdashboard%2Facme",
    );
  });
});

describe("withNextParam", () => {
  it("appends next to the auth callback url", () => {
    expect(withNextParam("/auth/callback", "http://localhost:3100", "/dashboard/acme")).toBe(
      "http://localhost:3100/auth/callback?next=%2Fdashboard%2Facme",
    );
  });
});
