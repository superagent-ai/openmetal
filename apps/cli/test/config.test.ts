import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPath,
  credentialsPath,
  resolveSettings,
  storeProjectKey,
  storeSession,
  updateProfile,
  type RuntimeEnvironment,
} from "../src/config.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function environment(): Promise<RuntimeEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), "openmetal-cli-"));
  directories.push(directory);
  return { OPENMETAL_CONFIG_HOME: directory };
}

describe("configuration", () => {
  it("resolves flags, environment, profile, and credentials in order", async () => {
    const env = await environment();
    await updateProfile(
      "default",
      {
        apiUrl: "https://profile.example.test/",
        organizationId: "org-profile",
        projectId: "prj_profile",
      },
      env,
    );
    await updateProfile("default", { organizationId: undefined, projectId: "prj_profile" }, env);
    await storeProjectKey("default", "prj_profile", "metal_sk_profile", env);
    await storeSession(
      "default",
      { accessToken: "stored-access", refreshToken: "stored-refresh" },
      env,
    );

    expect(await resolveSettings({}, env)).toMatchObject({
      apiUrl: "https://profile.example.test",
      organizationId: "org-profile",
      projectId: "prj_profile",
      apiKey: "metal_sk_profile",
      accessToken: "stored-access",
    });

    expect(
      await resolveSettings(
        { apiUrl: "https://flag.example.test", projectId: "prj_flag", apiKey: "metal_sk_flag" },
        {
          ...env,
          OPENMETAL_API_URL: "https://env.example.test",
          OPENMETAL_PROJECT_ID: "prj_env",
          OPENMETAL_API_KEY: "metal_sk_env",
        },
      ),
    ).toMatchObject({
      apiUrl: "https://flag.example.test",
      projectId: "prj_flag",
      apiKey: "metal_sk_flag",
    });
  });

  it("writes configuration and credentials without mixing secrets", async () => {
    const env = await environment();
    await updateProfile("default", { apiUrl: "https://api.example.test" }, env);
    await storeProjectKey("default", "prj_test", "metal_sk_secret", env);

    expect(await readFile(configPath(env), "utf8")).not.toContain("metal_sk_secret");
    expect(await readFile(credentialsPath(env), "utf8")).toContain("metal_sk_secret");
    if (process.platform !== "win32") {
      expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects malformed configuration", async () => {
    const env = await environment();
    await writeFile(configPath(env), "{not json");
    await expect(resolveSettings({}, env)).rejects.toThrow("invalid OpenMetal configuration");
  });
});
