import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { authStatus, startLoginCallback } from "../src/auth.js";

describe("PKCE loopback callback", () => {
  it("accepts a matching state and authorization code", async () => {
    const callback = await startLoginCallback("expected-state", 5_000, 0);
    const address = callback.server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/callback?state=expected-state&code=auth-code`,
    );
    expect(response.status).toBe(200);
    await expect(callback.code).resolves.toBe("auth-code");
    await new Promise<void>((resolve, reject) =>
      callback.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("rejects callbacks with a mismatched state", async () => {
    const callback = await startLoginCallback("expected-state", 5_000, 0);
    const address = callback.server.address() as AddressInfo;
    const rejectedCode = expect(callback.code).rejects.toThrow("invalid authentication callback");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/callback?state=wrong&code=auth-code`,
    );
    expect(response.status).toBe(400);
    await rejectedCode;
    await new Promise<void>((resolve, reject) =>
      callback.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("reports an explicit access-token override as authenticated", async () => {
    await expect(
      authStatus(
        {
          profileName: "default",
          apiUrl: "https://api.example.test",
          accessToken: "explicit-token",
        },
        { OPENMETAL_CONFIG_HOME: "/nonexistent/openmetal-test" },
      ),
    ).resolves.toMatchObject({ authenticated: true, source: "flag" });
  });

  it("rejects immediately when the callback port is occupied", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    const startedAt = Date.now();

    await expect(startLoginCallback("state", 5_000, port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
