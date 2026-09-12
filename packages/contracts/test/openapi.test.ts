import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/index.js";

type JsonObject = Record<string, unknown>;

const document = buildOpenApiDocument() as JsonObject;

function resolveReference(reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object" ? (value as JsonObject)[part] : undefined,
      document,
    );
}

function visit(value: unknown, callback: (value: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!value || typeof value !== "object") return;
  callback(value as JsonObject);
  for (const child of Object.values(value as JsonObject)) {
    visit(child, callback);
  }
}

describe("generated OpenAPI document", () => {
  it("resolves every internal reference", () => {
    const unresolved: string[] = [];
    visit(document, (value) => {
      if (typeof value.$ref === "string" && !resolveReference(value.$ref)) {
        unresolved.push(value.$ref);
      }
    });
    expect(unresolved).toEqual([]);
  });

  it("uses unique operation IDs", () => {
    const ids: string[] = [];
    visit((document.paths ?? {}) as JsonObject, (value) => {
      if (typeof value.operationId === "string") ids.push(value.operationId);
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares every path variable as a path parameter", () => {
    const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
    const failures: string[] = [];
    for (const [path, rawItem] of Object.entries(document.paths as JsonObject)) {
      const item = rawItem as JsonObject;
      const variables = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const [method, rawOperation] of Object.entries(item)) {
        if (!methods.has(method)) continue;
        const operation = rawOperation as JsonObject;
        const parameters = [
          ...((item.parameters as unknown[]) ?? []),
          ...((operation.parameters as unknown[]) ?? []),
        ].map((parameter) => {
          const value = parameter as JsonObject;
          return typeof value.$ref === "string"
            ? (resolveReference(value.$ref) as JsonObject)
            : value;
        });
        for (const variable of variables) {
          if (
            !parameters.some(
              (parameter) =>
                parameter?.name === variable &&
                parameter?.in === "path" &&
                parameter?.required === true,
            )
          ) {
            failures.push(`${method.toUpperCase()} ${path}: ${variable}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("uses stable named schemas without redundant draft declarations", () => {
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('"$schema"');
    expect(serialized).not.toContain("provider_cost_microusd");
    visit(document, (value) => {
      if (value.format === "uuid" || value.format === "date-time") {
        expect(value.pattern).toBeUndefined();
      }
    });
    const schemas = (document.components as JsonObject).schemas as JsonObject;
    const create = schemas.CreateSandboxRequest as JsonObject;
    expect(create.required).not.toEqual(
      expect.arrayContaining([
        "environment",
        "fallback",
        "metadata",
        "provider",
        "provider_options",
        "secret_refs",
      ]),
    );
    expect(JSON.stringify(create)).toContain("pause_resume");
    expect(JSON.stringify(create)).toContain("public_ports");
  });

  it("references named objects inside response schemas", () => {
    const schemas = (document.components as JsonObject).schemas as JsonObject;
    expect((schemas.Organization as JsonObject).title).toBe("Organization");

    const organizationList = schemas.OrganizationListResponse as JsonObject;
    const organizationProperties = organizationList.properties as JsonObject;
    const organizations = organizationProperties.organizations as JsonObject;
    expect((organizations.items as JsonObject).$ref).toBe("#/components/schemas/Organization");

    const membersResponse = schemas.OrganizationMembersResponse as JsonObject;
    const memberProperties = membersResponse.properties as JsonObject;
    expect(((memberProperties.members as JsonObject).items as JsonObject).$ref).toBe(
      "#/components/schemas/OrganizationMember",
    );
    expect(((memberProperties.invitations as JsonObject).items as JsonObject).$ref).toBe(
      "#/components/schemas/OrganizationInvitation",
    );

    const eventPage = schemas.CursorEventPage as JsonObject;
    const eventProperties = eventPage.properties as JsonObject;
    expect(((eventProperties.events as JsonObject).items as JsonObject).$ref).toBe(
      "#/components/schemas/DurableEventEnvelope",
    );
  });

  it("generates a TypeScript client contract that typechecks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "metal-openapi-"));
    try {
      const generated = astToString(await openapiTS(document as never));
      const file = join(directory, "client.d.ts");
      await writeFile(file, generated);
      const program = ts.createProgram([file], {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      expect(
        diagnostics.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
      ).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
