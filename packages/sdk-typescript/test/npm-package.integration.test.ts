import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type * as SdkModule from "../src/index.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("published SDK package", () => {
  it("installs without workspace dependencies and provides runtime and types", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "openmetal-sdk-"));
    directories.push(temporary);
    const packageDirectory = resolve("dist/npm");
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", packageDirectory, "--pack-destination", temporary, "--json"],
      { encoding: "utf8" },
    );
    const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
    const consumer = join(temporary, "consumer");
    await execFileAsync("npm", ["install", "--prefix", consumer, join(temporary, filename)], {
      encoding: "utf8",
    });

    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" })}\n`,
    );
    await writeFile(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022", "DOM"],
          skipLibCheck: false,
        },
        include: ["usage.ts"],
      })}\n`,
    );
    await writeFile(
      join(consumer, "usage.ts"),
      `import { MetalClient, MetalError, type OperationEvent } from "@openmetal/sdk";

const client = new MetalClient({
  baseUrl: "https://api.example.test",
  accessToken: () => "metal_sk_test",
  projectId: "prj_test",
});
const health: Promise<{ status: "ok" }> = client.health();
const event: OperationEvent | undefined = undefined;
void health;
void event;
void MetalError;
`,
    );
    await execFileAsync("pnpm", ["exec", "tsc", "--project", join(consumer, "tsconfig.json")], {
      encoding: "utf8",
    });

    const installedEntry = join(consumer, "node_modules", "@openmetal", "sdk", "index.js");
    const sdk = (await import(pathToFileURL(installedEntry).href)) as typeof SdkModule;
    const client = new sdk.MetalClient({
      baseUrl: "https://api.example.test",
      accessToken: () => "token",
      fetch: async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
  }, 30_000);
});
