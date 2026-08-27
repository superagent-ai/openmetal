import { describe, expect, it } from "vitest";
import {
  CreateProcessRequestSchema,
  CreateSandboxEndpointRequestSchema,
  ListFilesRequestSchema,
  ProcessEventSchema,
  ProcessIdSchema,
  ReadFileRequestSchema,
  RuntimeOperationSchema,
  RuntimeOperationIdSchema,
  SandboxEndpointIdSchema,
  WriteFileRequestSchema,
  buildOpenApiDocument,
} from "../src/index.js";

describe("portable runtime contracts", () => {
  it("applies bounded process defaults and validates public IDs", () => {
    expect(CreateProcessRequestSchema.parse({ command: ["sh", "-lc", "echo ok"] })).toMatchObject({
      timeout_seconds: 300,
      max_output_bytes: 10_485_760,
    });
    expect(ProcessIdSchema.safeParse("proc_abc123").success).toBe(true);
    expect(RuntimeOperationIdSchema.safeParse("rop_abc123").success).toBe(true);
    expect(SandboxEndpointIdSchema.safeParse("ep_abc123").success).toBe(true);
    expect(ProcessIdSchema.safeParse("op_abc123").success).toBe(false);
    expect(() =>
      CreateProcessRequestSchema.parse({ command: [], timeout_seconds: 3_601 }),
    ).toThrow();
  });

  it("preserves ordered binary-safe stdout and stderr chunks", () => {
    const stdout = ProcessEventSchema.parse({
      sequence: 7,
      process_id: "proc_abc123",
      type: "stdout",
      occurred_at: "2026-08-27T08:00:00.000Z",
      data: {
        data_base64: "AP+A",
        byte_length: 3,
        stream_offset_bytes: 0,
      },
    });
    expect(stdout.type).toBe("stdout");
    expect(() =>
      ProcessEventSchema.parse({
        ...stdout,
        sequence: 0,
      }),
    ).toThrow();
    expect(() =>
      ProcessEventSchema.parse({
        ...stdout,
        data: { ...stdout.data, data_base64: "not base64" },
      }),
    ).toThrow();
  });

  it("bounds filesystem payloads and rejects traversal paths", () => {
    expect(ReadFileRequestSchema.parse({ path: "/workspace/data.bin" })).toEqual({
      path: "/workspace/data.bin",
      offset_bytes: 0,
      limit_bytes: 1_048_576,
    });
    expect(ListFilesRequestSchema.parse({ path: "/workspace" })).toMatchObject({
      recursive: false,
      max_entries: 1_000,
    });
    expect(
      WriteFileRequestSchema.parse({
        path: "/workspace/data.bin",
        data_base64: "AAEC",
      }),
    ).toMatchObject({
      mode: "overwrite",
      create_parents: false,
    });
    expect(() =>
      WriteFileRequestSchema.parse({
        path: "/workspace/../secret",
        data_base64: "AAEC",
      }),
    ).toThrow();
    expect(() =>
      RuntimeOperationSchema.parse({
        id: "rop_abc123",
        type: "runtime_operation",
        project_id: "prj_abc123",
        sandbox_id: "sbx_abc123",
        kind: "filesystem_read",
        state: "succeeded",
        result: {
          kind: "filesystem_delete",
          path: "/workspace/data.bin",
          deleted: true,
        },
        error: null,
        created_at: "2026-08-27T08:00:00.000Z",
        started_at: "2026-08-27T08:00:01.000Z",
        completed_at: "2026-08-27T08:00:02.000Z",
      }),
    ).toThrow();
  });

  it("defaults and bounds HTTP endpoint leases", () => {
    expect(CreateSandboxEndpointRequestSchema.parse({ port: 3_000 })).toEqual({
      port: 3_000,
      protocol: "http",
      lease_seconds: 3_600,
    });
    expect(() =>
      CreateSandboxEndpointRequestSchema.parse({ port: 0, lease_seconds: 30 }),
    ).toThrow();
  });

  it("documents process, filesystem, operation, and endpoint routes", () => {
    const document = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };
    const operations = [
      ["post", "/v1/sandboxes/{sandbox_id}/processes", "createSandboxProcess"],
      ["get", "/v1/sandboxes/{sandbox_id}/processes/{process_id}", "getSandboxProcess"],
      [
        "get",
        "/v1/sandboxes/{sandbox_id}/processes/{process_id}/events",
        "streamSandboxProcessEvents",
      ],
      [
        "post",
        "/v1/sandboxes/{sandbox_id}/processes/{process_id}/actions/cancel",
        "cancelSandboxProcess",
      ],
      ["post", "/v1/sandboxes/{sandbox_id}/filesystem/read", "readSandboxFile"],
      ["post", "/v1/sandboxes/{sandbox_id}/filesystem/write", "writeSandboxFile"],
      ["post", "/v1/sandboxes/{sandbox_id}/filesystem/list", "listSandboxFiles"],
      ["post", "/v1/sandboxes/{sandbox_id}/filesystem/delete", "deleteSandboxFile"],
      [
        "get",
        "/v1/sandboxes/{sandbox_id}/runtime-operations/{runtime_operation_id}",
        "getSandboxRuntimeOperation",
      ],
      ["get", "/v1/sandboxes/{sandbox_id}/endpoints", "listSandboxEndpoints"],
      ["post", "/v1/sandboxes/{sandbox_id}/endpoints", "createSandboxEndpoint"],
      ["delete", "/v1/sandboxes/{sandbox_id}/endpoints/{endpoint_id}", "revokeSandboxEndpoint"],
    ] as const;

    for (const [method, path, operationId] of operations) {
      expect(document.paths[path]?.[method]?.operationId).toBe(operationId);
    }
    expect(document.paths["/v1/sandboxes/{sandbox_id}/processes"]?.post?.responses).toHaveProperty(
      "400",
    );
    expect(document.paths["/v1/sandboxes/{sandbox_id}/endpoints"]?.post?.responses).toHaveProperty(
      "400",
    );
  });
});
