import { siteOrigin } from "./auth-redirect";

export const siteName = "OpenMetal";
export const siteTagline = "The Compute Gateway for AI Agents";
export const siteDescription =
  "Give AI agents access to OpenMetal with one skill, one CLI, and one portable API.";

export function siteUrl(): URL {
  return new URL(siteOrigin());
}

export function absoluteUrl(path = "/"): string {
  return new URL(path, siteOrigin()).toString();
}

export function homeTitle(): string {
  return `${siteName} — ${siteTagline}`;
}
