import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, CreateSandboxRequestSchema } from "../src/index.js";

describe("OpenMetal agent skill", () => {
  it("has valid metadata and no missing local references", async () => {
    const skillUrl = new URL("../../../skills/openmetal/SKILL.md", import.meta.url);
    const skill = await readFile(skillUrl, "utf8");
    const references = [...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(
      (match) => match[1],
    );

    expect(skill).toMatch(/^---\nname: openmetal\ndescription: .+\ncompatibility: .+\n/);
    expect(references.length).toBeGreaterThan(0);
    await expect(
      Promise.all(references.map((reference) => readFile(new URL(reference, skillUrl), "utf8"))),
    ).resolves.toHaveLength(references.length);

    const evals = JSON.parse(
      await readFile(
        new URL("../../../skills/openmetal/evals/evals.json", import.meta.url),
        "utf8",
      ),
    ) as { skill_name?: unknown; evals?: unknown[] };
    expect(evals.skill_name).toBe("openmetal");
    expect(evals.evals).toHaveLength(3);
  });

  it("ships a sandbox example that matches the public contract", async () => {
    const exampleUrl = new URL(
      "../../../skills/openmetal/assets/sandbox.example.json",
      import.meta.url,
    );
    const example = JSON.parse(await readFile(exampleUrl, "utf8")) as unknown;

    expect(CreateSandboxRequestSchema.safeParse(example).success).toBe(true);
  });

  it("documents the shipped runtime surface without widening the terminal boundary", async () => {
    const root = new URL("../../../", import.meta.url);
    const [skill, runtime, cli, sdk, providers, publicRuntime] = await Promise.all([
      readFile(new URL("skills/openmetal/SKILL.md", root), "utf8"),
      readFile(new URL("skills/openmetal/references/runtime.md", root), "utf8"),
      readFile(new URL("skills/openmetal/references/cli.md", root), "utf8"),
      readFile(new URL("skills/openmetal/references/sdk.md", root), "utf8"),
      readFile(new URL("skills/openmetal/references/providers-and-billing.md", root), "utf8"),
      readFile(new URL("docs/runtime.md", root), "utf8"),
    ]);
    const documentedRuntime = `${runtime}\n${publicRuntime}`;
    const openapiPaths = Object.keys(buildOpenApiDocument().paths);

    for (const path of [
      "/v1/sandboxes/{sandbox_id}/processes",
      "/v1/sandboxes/{sandbox_id}/processes/{process_id}",
      "/v1/sandboxes/{sandbox_id}/processes/{process_id}/events",
      "/v1/sandboxes/{sandbox_id}/processes/{process_id}/actions/cancel",
      "/v1/sandboxes/{sandbox_id}/filesystem/read",
      "/v1/sandboxes/{sandbox_id}/filesystem/write",
      "/v1/sandboxes/{sandbox_id}/filesystem/list",
      "/v1/sandboxes/{sandbox_id}/filesystem/delete",
      "/v1/sandboxes/{sandbox_id}/runtime-operations/{runtime_operation_id}",
      "/v1/sandboxes/{sandbox_id}/endpoints",
      "/v1/sandboxes/{sandbox_id}/endpoints/{endpoint_id}",
    ]) {
      expect(openapiPaths).toContain(path);
      expect(documentedRuntime).toContain(path);
    }

    for (const command of [
      "openmetal sandbox exec",
      "openmetal process events",
      "openmetal file upload",
      "openmetal file download",
      "openmetal endpoint expose",
      "openmetal endpoint revoke",
    ]) {
      expect(`${skill}\n${cli}\n${runtime}`).toContain(command);
    }

    for (const method of [
      "metal.processes.create",
      "metal.processes.events",
      "metal.filesystem.upload",
      "metal.filesystem.download",
      "metal.runtimeOperations.wait",
      "metal.endpoints.create",
      "metal.endpoints.revoke",
    ]) {
      expect(`${sdk}\n${runtime}`).toContain(method);
    }

    expect(`${skill}\n${runtime}\n${sdk}`).toMatch(/interactive PTY\/terminal/);
    expect(`${skill}\n${runtime}\n${sdk}`).toMatch(/general connection/);
    expect(skill).not.toContain("does not yet expose public command execution");
    expect(providers).toContain("Cloudflare supports ordered process execution");
    expect(providers).toContain("Vercel file writes are additionally constrained");
    expect(providers).toContain("Only Blaxel exposes portable HTTP endpoints");
  });
});
