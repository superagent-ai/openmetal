import { expect, it, vi } from "vitest";
import { DaytonaSandboxProvider } from "../src/index.js";

it("declares the Daytona provider contract", () => {
  const provider = new DaytonaSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("daytona");
  expect(provider.capabilities.pause).toBe(false);
});

it("treats repeated destroy conflicts as idempotent success", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 409 }));
  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(provider.destroy("sandbox-1")).resolves.toBeUndefined();
  await expect(provider.destroy("sandbox-1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
