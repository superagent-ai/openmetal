import { MetalClient } from "@openmetal/sdk";

export function createMetalClient(accessToken: () => Promise<string | null | undefined>) {
  return new MetalClient({
    baseUrl: process.env.NEXT_PUBLIC_METAL_API_URL ?? "http://localhost:4000",
    accessToken,
    timeoutMs: 10_000,
  });
}
