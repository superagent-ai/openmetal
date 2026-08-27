import { MetalClient } from "@openmetal/sdk";
import { accessTokenForUser } from "./auth.js";
import type { ResolvedSettings, RuntimeEnvironment } from "./config.js";

export function anonymousClient(settings: ResolvedSettings): MetalClient {
  return new MetalClient({
    baseUrl: settings.apiUrl,
    accessToken: () => undefined,
  });
}

export function userClient(
  settings: ResolvedSettings,
  env: RuntimeEnvironment = process.env,
): MetalClient {
  return new MetalClient({
    baseUrl: settings.apiUrl,
    accessToken: () => accessTokenForUser(settings, env),
  });
}

export function projectClient(settings: ResolvedSettings): MetalClient {
  if (!settings.projectId) {
    throw new Error(
      "project is not selected; pass --project, set OPENMETAL_PROJECT_ID, or run `openmetal project use`",
    );
  }
  if (!settings.apiKey) {
    throw new Error(
      "project API key is not configured; set OPENMETAL_API_KEY or run `openmetal api-key use`",
    );
  }
  return new MetalClient({
    baseUrl: settings.apiUrl,
    projectId: settings.projectId,
    accessToken: () => settings.apiKey,
  });
}
