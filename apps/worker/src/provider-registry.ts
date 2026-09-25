import { BlaxelSandboxProvider } from "@openmetal/provider-blaxel";
import { CloudflareSandboxProvider } from "@openmetal/provider-cloudflare";
import { CodeSandboxProvider } from "@openmetal/provider-codesandbox";
import { DaytonaSandboxProvider } from "@openmetal/provider-daytona";
import { E2BSandboxProvider } from "@openmetal/provider-e2b";
import { FreestyleSandboxProvider } from "@openmetal/provider-freestyle";
import { ModalSandboxProvider } from "@openmetal/provider-modal";
import { NorthflankSandboxProvider } from "@openmetal/provider-northflank";
import { PrimeSandboxProvider } from "@openmetal/provider-prime";
import { RunloopSandboxProvider } from "@openmetal/provider-runloop";
import { VercelSandboxProvider } from "@openmetal/provider-vercel";
import type { ProviderCredentialInput } from "@openmetal/contracts";
import type { SandboxProvider, SandboxProviderName } from "@openmetal/provider-core";
import type { WorkerEnv } from "./env.js";

function usdRateToMicrousd(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  const [dollars = "0", decimals = ""] = value.split(".");
  return BigInt(dollars) * 1_000_000n + BigInt(decimals.padEnd(6, "0"));
}

export function buildSandboxProviders(
  env: WorkerEnv,
): Partial<Record<SandboxProviderName, SandboxProvider>> {
  const providers: Partial<Record<SandboxProviderName, SandboxProvider>> = {};
  const blaxelApiKey = env.BL_API_KEY ?? env.BLAXEL_API_KEY;
  const blaxelWorkspace = env.BL_WORKSPACE ?? env.BLAXEL_WORKSPACE;
  if (blaxelApiKey && blaxelWorkspace) {
    providers.blaxel = new BlaxelSandboxProvider({
      apiKey: blaxelApiKey,
      workspace: blaxelWorkspace,
      accountId: env.BLAXEL_ACCOUNT_ID,
      apiUrl: env.BLAXEL_API_URL,
      region: env.BLAXEL_REGION,
      defaultImage: env.BLAXEL_DEFAULT_IMAGE,
      defaultMemoryMb: env.BLAXEL_DEFAULT_MEMORY_MB,
    });
  }
  if (env.CLOUDFLARE_SANDBOX_API_URL && env.CLOUDFLARE_SANDBOX_API_KEY) {
    providers.cloudflare = new CloudflareSandboxProvider({
      apiUrl: env.CLOUDFLARE_SANDBOX_API_URL,
      apiKey: env.CLOUDFLARE_SANDBOX_API_KEY,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      analyticsToken: env.CLOUDFLARE_ANALYTICS_API_TOKEN,
    });
  }
  if (env.CODESANDBOX_API_KEY) {
    providers.codesandbox = new CodeSandboxProvider({
      apiKey: env.CODESANDBOX_API_KEY,
      apiUrl: env.CODESANDBOX_API_URL,
      templateId: env.CODESANDBOX_TEMPLATE_ID,
      vmTier: env.CODESANDBOX_VM_TIER,
      workspaceId: env.CODESANDBOX_WORKSPACE_ID,
      creditRateMicrousd:
        env.CODESANDBOX_CREDIT_RATE_USD === undefined
          ? undefined
          : BigInt(Math.round(env.CODESANDBOX_CREDIT_RATE_USD * 1_000_000)),
    });
  }
  if (env.DAYTONA_API_KEY) {
    providers.daytona = new DaytonaSandboxProvider({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL,
      analyticsApiUrl: env.DAYTONA_ANALYTICS_API_URL,
      target: env.DAYTONA_TARGET,
      pauseSupported: env.DAYTONA_PAUSE_SUPPORTED,
    });
  }
  if (env.E2B_API_KEY) {
    providers.e2b = new E2BSandboxProvider({
      apiKey: env.E2B_API_KEY,
      apiUrl: env.E2B_API_URL,
      templateId: env.E2B_TEMPLATE_ID,
    });
  }
  if (env.FREESTYLE_API_KEY) {
    providers.freestyle = new FreestyleSandboxProvider({
      apiKey: env.FREESTYLE_API_KEY,
      apiUrl: env.FREESTYLE_API_URL,
      snapshotId: env.FREESTYLE_SNAPSHOT_ID,
    });
  }
  if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) {
    providers.modal = new ModalSandboxProvider({
      tokenId: env.MODAL_TOKEN_ID,
      tokenSecret: env.MODAL_TOKEN_SECRET,
      appName: env.MODAL_APP_NAME,
      environment: env.MODAL_ENVIRONMENT,
    });
  }
  if (env.NORTHFLANK_API_TOKEN && env.NORTHFLANK_PROJECT_ID) {
    providers.northflank = new NorthflankSandboxProvider({
      apiToken: env.NORTHFLANK_API_TOKEN,
      projectId: env.NORTHFLANK_PROJECT_ID,
      teamId: env.NORTHFLANK_TEAM_ID,
      apiUrl: env.NORTHFLANK_API_URL,
      deploymentPlan: env.NORTHFLANK_DEPLOYMENT_PLAN,
      defaultImage: env.NORTHFLANK_DEFAULT_IMAGE,
      ephemeralStorageMb: env.NORTHFLANK_EPHEMERAL_STORAGE_MB,
    });
  }
  if (env.PRIME_API_KEY) {
    providers.prime = new PrimeSandboxProvider({
      apiKey: env.PRIME_API_KEY,
      apiUrl: env.PRIME_API_URL,
      teamId: env.PRIME_TEAM_ID,
    });
  }
  if (env.RUNLOOP_API_KEY) {
    const usageRatesMicrousd =
      env.RUNLOOP_VCPU_HOUR_RATE_USD !== undefined &&
      env.RUNLOOP_MEMORY_GB_HOUR_RATE_USD !== undefined &&
      env.RUNLOOP_DISK_GB_HOUR_RATE_USD !== undefined
        ? {
            vcpuHour: BigInt(Math.round(env.RUNLOOP_VCPU_HOUR_RATE_USD * 1_000_000)),
            memoryGbHour: BigInt(Math.round(env.RUNLOOP_MEMORY_GB_HOUR_RATE_USD * 1_000_000)),
            diskGbHour: BigInt(Math.round(env.RUNLOOP_DISK_GB_HOUR_RATE_USD * 1_000_000)),
          }
        : undefined;
    providers.runloop = new RunloopSandboxProvider({
      apiKey: env.RUNLOOP_API_KEY,
      apiUrl: env.RUNLOOP_API_URL,
      resourceSize: env.RUNLOOP_RESOURCE_SIZE,
      blueprintId: env.RUNLOOP_BLUEPRINT_ID,
      usageRatesMicrousd,
    });
  }
  const vercelToken = env.VERCEL_OIDC_TOKEN ?? env.VERCEL_TOKEN;
  if (vercelToken && env.VERCEL_PROJECT_ID) {
    providers.vercel = new VercelSandboxProvider({
      token: vercelToken,
      projectId: env.VERCEL_PROJECT_ID,
      teamId: env.VERCEL_TEAM_ID,
      apiUrl: env.VERCEL_API_URL,
    });
  }
  return providers;
}

export function buildByokSandboxProvider(credential: ProviderCredentialInput): SandboxProvider {
  switch (credential.provider) {
    case "blaxel":
      return new BlaxelSandboxProvider({
        apiKey: credential.api_key,
        workspace: credential.workspace,
        accountId: credential.account_id,
      });
    case "cloudflare":
      return new CloudflareSandboxProvider({
        apiUrl: credential.api_url,
        apiKey: credential.api_key,
        accountId: credential.account_id,
        analyticsToken: credential.analytics_token,
      });
    case "codesandbox":
      return new CodeSandboxProvider({
        apiKey: credential.api_key,
        workspaceId: credential.workspace_id,
        vmTier: credential.vm_tier,
        creditRateMicrousd: usdRateToMicrousd(credential.credit_rate_usd),
      });
    case "daytona":
      return new DaytonaSandboxProvider({
        apiKey: credential.api_key,
        organizationId: credential.organization_id,
        target: credential.target,
      });
    case "e2b":
      return new E2BSandboxProvider({ apiKey: credential.api_key });
    case "freestyle":
      return new FreestyleSandboxProvider({ apiKey: credential.api_key });
    case "modal":
      return new ModalSandboxProvider({
        tokenId: credential.token_id,
        tokenSecret: credential.token_secret,
        environment: credential.environment,
      });
    case "northflank":
      return new NorthflankSandboxProvider({
        apiToken: credential.api_token,
        projectId: credential.project_id,
        teamId: credential.team_id,
      });
    case "prime":
      return new PrimeSandboxProvider({ apiKey: credential.api_key, teamId: credential.team_id });
    case "runloop":
      return new RunloopSandboxProvider({
        apiKey: credential.api_key,
        resourceSize: credential.resource_size,
        usageRatesMicrousd:
          credential.vcpu_hour_rate_usd &&
          credential.memory_gb_hour_rate_usd &&
          credential.disk_gb_hour_rate_usd
            ? {
                vcpuHour: usdRateToMicrousd(credential.vcpu_hour_rate_usd)!,
                memoryGbHour: usdRateToMicrousd(credential.memory_gb_hour_rate_usd)!,
                diskGbHour: usdRateToMicrousd(credential.disk_gb_hour_rate_usd)!,
              }
            : undefined,
      });
    case "vercel":
      return new VercelSandboxProvider({
        token: credential.token,
        projectId: credential.project_id,
        teamId: credential.team_id,
      });
  }
}
