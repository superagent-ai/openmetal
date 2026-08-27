import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CreateSandboxRequestSchema } from "../src/index.js";

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
});
