import { describe, expect, it, vi } from "vitest";
import {
  MetalClient,
  MetalError,
  RuntimeOperationWaitError,
  type ProcessEvent,
} from "../src/index.js";

const now = "2026-08-27T10:00:00.000Z";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function process(state = "running") {
  return {
    id: "proc_test",
    type: "process",
    project_id: "prj_test",
    sandbox_id: "sbx_test",
    state,
    command: ["printf", "hello"],
    cwd: null,
    timeout_seconds: 300,
    max_output_bytes: 10_485_760,
    output_bytes: 0,
    output_truncated: false,
    exit_code: null,
    termination_signal: null,
    error: null,
    cancel_requested_at: null,
    created_at: now,
    started_at: now,
    completed_at: null,
  };
}

function runtimeOperation(
  kind:
    | "filesystem_read"
    | "filesystem_write"
    | "filesystem_list"
    | "filesystem_delete"
    | "computer_action"
    | "computer_screenshot",
  state = "queued",
  result: unknown = null,
) {
  return {
    id: "rop_test",
    type: "runtime_operation",
    project_id: "prj_test",
    sandbox_id: "sbx_test",
    kind,
    state,
    result,
    error: null,
    created_at: now,
    started_at: state === "queued" ? null : now,
    completed_at: state === "succeeded" ? now : null,
  };
}

function endpoint(state = "active") {
  return {
    id: "ep_test",
    type: "sandbox_endpoint",
    project_id: "prj_test",
    sandbox_id: "sbx_test",
    port: 8080,
    protocol: "http",
    state,
    url: state === "active" ? "https://ep.example.test" : null,
    lease_expires_at: "2026-08-27T11:00:00.000Z",
    revoked_at: state === "revoked" ? now : null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

function recording(state = "recording") {
  return {
    id: "rec_test",
    type: "sandbox_recording",
    project_id: "prj_test",
    sandbox_id: "sbx_test",
    state,
    format: "mp4",
    label: null,
    artifact:
      state === "stopped"
        ? {
            kind: "sandbox_file",
            path: "/workspace/rec_test.mp4",
            media_type: "video/mp4",
          }
        : null,
    size_bytes: state === "stopped" ? 1024 : null,
    duration_seconds: state === "stopped" ? 1 : null,
    error: null,
    created_at: now,
    started_at: now,
    stopped_at: state === "stopped" ? now : null,
    updated_at: now,
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("MetalClient runtime namespaces", () => {
  it("creates, gets, and cancels processes on the documented routes", async () => {
    const requests: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: init?.body?.toString(),
        });
        return jsonResponse(202, process());
      },
    });

    const created = await client.processes.create(
      "sbx_test",
      { command: ["printf", "hello"] },
      { idempotencyKey: "process-key" },
    );
    await client.processes.get("sbx_test", "proc_test");
    await client.processes.cancel("sbx_test", "proc_test", { idempotencyKey: "cancel-key" });

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "http://localhost:4000/v1/sandboxes/sbx_test/processes"],
      ["GET", "http://localhost:4000/v1/sandboxes/sbx_test/processes/proc_test"],
      ["POST", "http://localhost:4000/v1/sandboxes/sbx_test/processes/proc_test/actions/cancel"],
    ]);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("process-key");
    expect(created.id).toBe("proc_test");
    expect(requests[2]?.headers.get("idempotency-key")).toBe("cancel-key");
    expect(requests.every(({ headers }) => headers.get("x-metal-project-id") === "prj_test")).toBe(
      true,
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      command: ["printf", "hello"],
      timeout_seconds: 300,
      max_output_bytes: 10_485_760,
    });
  });

  it("exposes a generated process key when a create times out after send", async () => {
    let sentKey: string | null = null;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      timeoutMs: 10,
      fetch: async (_url, init) => {
        sentKey = new Headers(init?.headers).get("idempotency-key");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted after send");
            error.name = "AbortError";
            reject(error);
          });
        });
      },
    });

    const failure = await client.processes
      .create("sbx_test", { command: ["run"] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetalError);
    expect(failure).toMatchObject({ code: "timeout", idempotencyKey: sentKey });
    expect(sentKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves an explicit process key on API errors", async () => {
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      fetch: async () =>
        jsonResponse(503, {
          code: "service_unavailable",
          message: "create outcome is unknown",
          request_id: "req_process",
          retryable: true,
        }),
    });

    await expect(
      client.processes.create(
        "sbx_test",
        { command: ["run"] },
        { idempotencyKey: "process-explicit-key" },
      ),
    ).rejects.toMatchObject({
      code: "service_unavailable",
      idempotencyKey: "process-explicit-key",
    });
  });

  it("streams ordered process events and resumes each finite SSE batch", async () => {
    const lastEventIds: Array<string | null> = [];
    const batches = [
      [
        {
          sequence: 1,
          process_id: "proc_test",
          type: "queued",
          occurred_at: now,
          data: {},
        },
        {
          sequence: 2,
          process_id: "proc_test",
          type: "stdout",
          occurred_at: now,
          data: {
            data_base64: "AP+A",
            byte_length: 3,
            stream_offset_bytes: 0,
          },
        },
      ],
      [
        {
          sequence: 3,
          process_id: "proc_test",
          type: "stderr",
          occurred_at: now,
          data: {
            data_base64: "gQE=",
            byte_length: 2,
            stream_offset_bytes: 0,
          },
        },
        {
          sequence: 4,
          process_id: "proc_test",
          type: "exited",
          occurred_at: now,
          data: { exit_code: 0 },
        },
      ],
    ] satisfies ProcessEvent[][];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      lastEventIds.push(new Headers(init?.headers).get("last-event-id"));
      const events = batches.shift() ?? [];
      return new Response(
        events
          .map(
            (event) =>
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: fetchMock,
    });

    const events = await collect(
      client.processes.events("sbx_test", "proc_test", { reconnectDelayMs: 0 }),
    );

    expect(events.map(({ sequence, type }) => [sequence, type])).toEqual([
      [1, "queued"],
      [2, "stdout"],
      [3, "stderr"],
      [4, "exited"],
    ]);
    expect(events[1]).toMatchObject({
      data: { data_base64: "AP+A", byte_length: 3, stream_offset_bytes: 0 },
    });
    expect(lastEventIds).toEqual([null, "2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts process event streams from an explicit Last-Event-ID", async () => {
    let lastEventId: string | null = null;
    const finalEvent = {
      sequence: 8,
      process_id: "proc_test",
      type: "cancelled",
      occurred_at: now,
      data: { termination_signal: "SIGTERM" },
    };
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      fetch: async (_url, init) => {
        lastEventId = new Headers(init?.headers).get("last-event-id");
        return new Response(`id: 8\nevent: cancelled\ndata: ${JSON.stringify(finalEvent)}\n\n`, {
          status: 200,
        });
      },
    });

    await expect(
      collect(client.processes.events("sbx_test", "proc_test", { lastEventId: 7 })),
    ).resolves.toEqual([finalEvent]);
    expect(lastEventId).toBe("7");
  });

  it("ends a resumed process event stream when an empty batch belongs to a terminal process", async () => {
    const requests: Array<{ url: string; lastEventId: string | null }> = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          lastEventId: new Headers(init?.headers).get("last-event-id"),
        });
        if (String(url).endsWith("/events")) {
          return new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return jsonResponse(200, process("succeeded"));
      },
    });

    await expect(
      collect(
        client.processes.events("sbx_test", "proc_test", {
          lastEventId: 8,
          reconnectDelayMs: 10_000,
        }),
      ),
    ).resolves.toEqual([]);
    expect(requests).toEqual([
      {
        url: "http://localhost:4000/v1/sandboxes/sbx_test/processes/proc_test/events",
        lastEventId: "8",
      },
      {
        url: "http://localhost:4000/v1/sandboxes/sbx_test/processes/proc_test",
        lastEventId: null,
      },
    ]);
  });

  it("rejects gaps rather than silently reordering process output", async () => {
    const event = {
      sequence: 2,
      process_id: "proc_test",
      type: "stdout",
      occurred_at: now,
      data: { data_base64: "YQ==", byte_length: 1, stream_offset_bytes: 0 },
    };
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      fetch: async () =>
        new Response(`id: 2\nevent: stdout\ndata: ${JSON.stringify(event)}\n\n`, {
          status: 200,
        }),
    });

    await expect(collect(client.processes.events("sbx_test", "proc_test"))).rejects.toMatchObject({
      code: "internal_error",
      message: "process event sequence 2 followed 0",
    });
  });

  it("encodes binary filesystem writes without UTF-8 conversion", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
        return jsonResponse(202, runtimeOperation("filesystem_write"));
      },
    });

    await client.filesystem.write(
      "sbx_test",
      {
        path: "/tmp/data.bin",
        data: new Uint8Array([0, 255, 128, 65]),
        mode: "create",
        create_parents: true,
      },
      { idempotencyKey: "write-key" },
    );

    expect(capturedBody).toEqual({
      path: "/tmp/data.bin",
      data_base64: "AP+AQQ==",
      mode: "create",
      create_parents: true,
    });
  });

  it("exposes a generated filesystem write key on API errors", async () => {
    let sentKey: string | null = null;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      fetch: async (_url, init) => {
        sentKey = new Headers(init?.headers).get("idempotency-key");
        return jsonResponse(503, {
          code: "service_unavailable",
          message: "write outcome is unknown",
          request_id: "req_write",
          retryable: true,
        });
      },
    });

    const failure = await client.filesystem
      .write("sbx_test", { path: "/tmp/data.bin", data_base64: "AQ==" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetalError);
    expect(failure).toMatchObject({ code: "service_unavailable", idempotencyKey: sentKey });
    expect(sentKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("exposes a generated upload key when its write times out after send", async () => {
    let sentKey: string | null = null;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      timeoutMs: 10,
      fetch: async (_url, init) => {
        sentKey = new Headers(init?.headers).get("idempotency-key");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted after send");
            error.name = "AbortError";
            reject(error);
          });
        });
      },
    });

    const failure = await client.filesystem
      .upload("sbx_test", "/tmp/data.bin", new Uint8Array([1]))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetalError);
    expect(failure).not.toBeInstanceOf(RuntimeOperationWaitError);
    expect(failure).toMatchObject({ code: "timeout", idempotencyKey: sentKey });
    expect(sentKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves an accepted write operation and generated idempotency key when upload waiting fails", async () => {
    let idempotencyKey: string | null = null;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      fetch: async (_url, init) => {
        if (init?.method === "POST") {
          idempotencyKey = new Headers(init.headers).get("idempotency-key");
          return jsonResponse(202, runtimeOperation("filesystem_write"));
        }
        return jsonResponse(200, {
          ...runtimeOperation("filesystem_write", "failed"),
          error: { code: "provider_error", message: "remote write failed", retryable: false },
          completed_at: now,
        });
      },
    });

    const failure = await client.filesystem
      .upload("sbx_test", "/tmp/append.bin", new Uint8Array([1]), {
        mode: "append",
        pollIntervalMs: 0,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeOperationWaitError);
    expect(failure).toMatchObject({
      message: "remote write failed",
      operationId: "rop_test",
      idempotencyKey,
    });
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("downloads binary bytes after polling the runtime operation", async () => {
    const urls: string[] = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: async (url, init) => {
        urls.push(String(url));
        if (init?.method === "POST") {
          return jsonResponse(202, runtimeOperation("filesystem_read"));
        }
        return jsonResponse(
          200,
          runtimeOperation("filesystem_read", "succeeded", {
            kind: "filesystem_read",
            path: "/tmp/data.bin",
            data_base64: "AP+AQQ==",
            offset_bytes: 0,
            byte_length: 4,
            eof: true,
          }),
        );
      },
    });

    const bytes = await client.filesystem.download("sbx_test", "/tmp/data.bin");

    expect(Array.from(bytes)).toEqual([0, 255, 128, 65]);
    expect(urls).toEqual([
      "http://localhost:4000/v1/sandboxes/sbx_test/filesystem/read",
      "http://localhost:4000/v1/sandboxes/sbx_test/runtime-operations/rop_test",
    ]);
  });

  it("continues binary downloads from the returned byte offset until EOF", async () => {
    let completedReads = 0;
    const readBodies: Array<Record<string, unknown>> = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: async (_url, init) => {
        if (init?.method === "POST") {
          readBodies.push(JSON.parse(init.body?.toString() ?? "{}") as Record<string, unknown>);
          return jsonResponse(202, runtimeOperation("filesystem_read"));
        }
        const first = completedReads++ === 0;
        return jsonResponse(
          200,
          runtimeOperation("filesystem_read", "succeeded", {
            kind: "filesystem_read",
            path: "/tmp/chunked.bin",
            data_base64: first ? "AP8=" : "gEE=",
            offset_bytes: first ? 0 : 2,
            byte_length: 2,
            eof: !first,
          }),
        );
      },
    });

    await expect(
      client.filesystem.download("sbx_test", "/tmp/chunked.bin", {
        chunkSizeBytes: 2,
      }),
    ).resolves.toEqual(new Uint8Array([0, 255, 128, 65]));
    expect(readBodies).toEqual([
      { path: "/tmp/chunked.bin", offset_bytes: 0, limit_bytes: 2 },
      { path: "/tmp/chunked.bin", offset_bytes: 2, limit_bytes: 2 },
    ]);
  });

  it.each([
    {
      name: "path",
      result: {
        kind: "filesystem_read",
        path: "/tmp/other.bin",
        data_base64: "YQ==",
        offset_bytes: 0,
        byte_length: 1,
        eof: true,
      },
      message: "returned path /tmp/other.bin instead of /tmp/data.bin",
    },
    {
      name: "offset",
      result: {
        kind: "filesystem_read",
        path: "/tmp/data.bin",
        data_base64: "YQ==",
        offset_bytes: 1,
        byte_length: 1,
        eof: true,
      },
      message: "returned offset 1 instead of 0",
    },
    {
      name: "zero-progress",
      result: {
        kind: "filesystem_read",
        path: "/tmp/data.bin",
        data_base64: "",
        offset_bytes: 0,
        byte_length: 0,
        eof: false,
      },
      message: "made no progress",
    },
  ])(
    "rejects a filesystem download result with invalid $name before returning bytes",
    async ({ result, message }) => {
      const client = new MetalClient({
        baseUrl: "http://localhost:4000",
        accessToken: async () => "metal_sk_test",
        fetch: async (_url, init) =>
          init?.method === "POST"
            ? jsonResponse(202, runtimeOperation("filesystem_read"))
            : jsonResponse(200, runtimeOperation("filesystem_read", "succeeded", result)),
      });

      await expect(client.filesystem.download("sbx_test", "/tmp/data.bin")).rejects.toThrow(
        message,
      );
    },
  );

  it("uses endpoint pagination and create/revoke routes", async () => {
    const requests: Array<{ url: string; method?: string; key: string | null }> = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method,
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        if (init?.method === "GET") {
          return jsonResponse(200, { endpoints: [endpoint()], next_cursor: "cursor-2" });
        }
        return jsonResponse(202, endpoint(init?.method === "DELETE" ? "revoked" : "active"));
      },
    });

    await client.endpoints.create("sbx_test", { port: 8080 }, { idempotencyKey: "endpoint-key" });
    await expect(
      client.endpoints.list("sbx_test", { cursor: "cursor-1", limit: 25 }),
    ).resolves.toMatchObject({ next_cursor: "cursor-2" });
    await client.endpoints.revoke("sbx_test", "ep_test");

    expect(requests).toEqual([
      {
        url: "http://localhost:4000/v1/sandboxes/sbx_test/endpoints",
        method: "POST",
        key: "endpoint-key",
      },
      {
        url: "http://localhost:4000/v1/sandboxes/sbx_test/endpoints?cursor=cursor-1&limit=25",
        method: "GET",
        key: null,
      },
      {
        url: "http://localhost:4000/v1/sandboxes/sbx_test/endpoints/ep_test",
        method: "DELETE",
        key: null,
      },
    ]);
  });

  it("exposes portable computer and recording routes", async () => {
    const requests: Array<{ url: string; method?: string; key: string | null }> = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "metal_sk_test",
      projectId: "prj_test",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method,
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        const path = String(url);
        if (path.endsWith("/computer/actions")) {
          return jsonResponse(202, runtimeOperation("computer_action"));
        }
        if (path.endsWith("/computer/screenshots")) {
          return jsonResponse(202, runtimeOperation("computer_screenshot"));
        }
        if (path.endsWith("/recordings") && init?.method === "GET") {
          return jsonResponse(200, { recordings: [recording()], next_cursor: null });
        }
        return jsonResponse(
          202,
          recording(path.endsWith("/actions/stop") ? "stopped" : "recording"),
        );
      },
    });

    await client.computer.action(
      "sbx_test",
      { type: "mouse_click", x: 1, y: 2 },
      { idempotencyKey: "action-key" },
    );
    await client.computer.screenshot("sbx_test");
    await client.recordings.start("sbx_test", {}, { idempotencyKey: "recording-key" });
    await client.recordings.list("sbx_test");
    await client.recordings.stop("sbx_test", "rec_test", { idempotencyKey: "stop-key" });

    expect(requests.map(({ method, url, key }) => [method, url, key])).toEqual([
      ["POST", "http://localhost:4000/v1/sandboxes/sbx_test/computer/actions", "action-key"],
      ["POST", "http://localhost:4000/v1/sandboxes/sbx_test/computer/screenshots", null],
      ["POST", "http://localhost:4000/v1/sandboxes/sbx_test/recordings", "recording-key"],
      ["GET", "http://localhost:4000/v1/sandboxes/sbx_test/recordings", null],
      [
        "POST",
        "http://localhost:4000/v1/sandboxes/sbx_test/recordings/rec_test/actions/stop",
        "stop-key",
      ],
    ]);
  });
});
