import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { MetalClient } from "../src/index.js";

const now = "2026-08-27T10:00:00.000Z";

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function process(state = "running") {
  return {
    id: "proc_http",
    type: "process",
    project_id: "prj_http",
    sandbox_id: "sbx_http",
    state,
    command: ["run"],
    cwd: null,
    timeout_seconds: 300,
    max_output_bytes: 10_485_760,
    output_bytes: 4,
    output_truncated: false,
    exit_code: state === "succeeded" ? 0 : null,
    termination_signal: null,
    error: null,
    cancel_requested_at: null,
    created_at: now,
    started_at: now,
    completed_at: state === "succeeded" ? now : null,
  };
}

function operation(
  id: string,
  kind: "filesystem_read" | "filesystem_write" | "filesystem_list" | "filesystem_delete",
  state = "queued",
  result: unknown = null,
) {
  return {
    id,
    type: "runtime_operation",
    project_id: "prj_http",
    sandbox_id: "sbx_http",
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
    id: "ep_http",
    type: "sandbox_endpoint",
    project_id: "prj_http",
    sandbox_id: "sbx_http",
    port: 3000,
    protocol: "http",
    state,
    url: state === "active" ? "https://runtime.example.test" : null,
    lease_expires_at: "2026-08-27T11:00:00.000Z",
    revoked_at: state === "revoked" ? now : null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}

describe("MetalClient runtime HTTP fixtures", () => {
  let server: Server;
  let baseUrl = "";
  const requests: Array<{
    authorization?: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    lastEventId?: string;
    method?: string;
    projectId?: string;
    url?: string;
  }> = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const body =
        request.method === "POST" && request.headers["content-type"] === "application/json"
          ? await readJson(request)
          : undefined;
      requests.push({
        authorization: request.headers.authorization,
        body,
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        lastEventId: request.headers["last-event-id"] as string | undefined,
        method: request.method,
        projectId: request.headers["x-metal-project-id"] as string | undefined,
        url: request.url,
      });
      response.setHeader("content-type", "application/json");

      if (request.url === "/v1/sandboxes/sbx_http/processes" && request.method === "POST") {
        response.statusCode = 202;
        response.end(JSON.stringify(process()));
        return;
      }
      if (
        request.url === "/v1/sandboxes/sbx_http/processes/proc_http" &&
        request.method === "GET"
      ) {
        response.end(JSON.stringify(process()));
        return;
      }
      if (
        request.url === "/v1/sandboxes/sbx_http/processes/proc_http/events" &&
        request.method === "GET"
      ) {
        response.setHeader("content-type", "text/event-stream");
        const event =
          request.headers["last-event-id"] === "1"
            ? {
                sequence: 2,
                process_id: "proc_http",
                type: "exited",
                occurred_at: now,
                data: { exit_code: 0 },
              }
            : {
                sequence: 1,
                process_id: "proc_http",
                type: "stdout",
                occurred_at: now,
                data: { data_base64: "AP+AQQ==", byte_length: 4, stream_offset_bytes: 0 },
              };
        response.end(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        return;
      }
      if (
        request.url === "/v1/sandboxes/sbx_http/processes/proc_http/actions/cancel" &&
        request.method === "POST"
      ) {
        response.statusCode = 409;
        response.end(
          JSON.stringify({
            code: "process_terminal",
            message: "process is already terminal",
            request_id: "req_runtime",
            retryable: false,
          }),
        );
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/filesystem/write") {
        response.statusCode = 202;
        response.end(JSON.stringify(operation("rop_write", "filesystem_write")));
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/filesystem/read") {
        response.statusCode = 202;
        response.end(JSON.stringify(operation("rop_read", "filesystem_read")));
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/filesystem/list") {
        response.statusCode = 202;
        response.end(JSON.stringify(operation("rop_list", "filesystem_list")));
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/filesystem/delete") {
        response.statusCode = 202;
        response.end(JSON.stringify(operation("rop_delete", "filesystem_delete")));
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/runtime-operations/rop_write") {
        response.end(
          JSON.stringify(
            operation("rop_write", "filesystem_write", "succeeded", {
              kind: "filesystem_write",
              path: "/tmp/http.bin",
              bytes_written: 4,
            }),
          ),
        );
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/runtime-operations/rop_read") {
        response.end(
          JSON.stringify(
            operation("rop_read", "filesystem_read", "succeeded", {
              kind: "filesystem_read",
              path: "/tmp/http.bin",
              data_base64: "AP+AQQ==",
              offset_bytes: 0,
              byte_length: 4,
              eof: true,
            }),
          ),
        );
        return;
      }
      if (request.url === "/v1/sandboxes/sbx_http/endpoints" && request.method === "POST") {
        response.statusCode = 202;
        response.end(JSON.stringify(endpoint()));
        return;
      }
      if (
        request.url === "/v1/sandboxes/sbx_http/endpoints?cursor=page-1&limit=10" &&
        request.method === "GET"
      ) {
        response.end(JSON.stringify({ endpoints: [endpoint()], next_cursor: "page-2" }));
        return;
      }
      if (
        request.url === "/v1/sandboxes/sbx_http/endpoints/ep_http" &&
        request.method === "DELETE"
      ) {
        response.statusCode = 202;
        response.end(JSON.stringify(endpoint("revoked")));
        return;
      }

      response.statusCode = 404;
      response.end(
        JSON.stringify({
          code: "not_found",
          message: "fixture route not found",
          request_id: "req_missing",
          retryable: false,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("exercises process, filesystem, endpoint, error, and pagination behavior", async () => {
    const client = new MetalClient({
      baseUrl,
      accessToken: async () => "metal_sk_http",
      projectId: "prj_http",
    });

    await client.processes.create(
      "sbx_http",
      { command: ["run"] },
      { idempotencyKey: "proc-http-key" },
    );
    await expect(client.processes.get("sbx_http", "proc_http")).resolves.toMatchObject({
      id: "proc_http",
    });
    await expect(
      collect(client.processes.events("sbx_http", "proc_http", { reconnectDelayMs: 0 })),
    ).resolves.toMatchObject([
      { sequence: 1, type: "stdout", data: { data_base64: "AP+AQQ==" } },
      { sequence: 2, type: "exited", data: { exit_code: 0 } },
    ]);
    await expect(client.processes.cancel("sbx_http", "proc_http")).rejects.toMatchObject({
      status: 409,
      code: "process_terminal",
      requestId: "req_runtime",
    });

    await expect(
      client.filesystem.upload(
        "sbx_http",
        "/tmp/http.bin",
        new Blob([new Uint8Array([0, 255, 128, 65])]),
        { idempotencyKey: "write-http-key" },
      ),
    ).resolves.toMatchObject({ state: "succeeded" });
    await expect(client.filesystem.download("sbx_http", "/tmp/http.bin")).resolves.toEqual(
      new Uint8Array([0, 255, 128, 65]),
    );
    await client.filesystem.list("sbx_http", { path: "/tmp", max_entries: 10 });
    await client.filesystem.delete(
      "sbx_http",
      { path: "/tmp/http.bin" },
      { idempotencyKey: "delete-http-key" },
    );

    await client.endpoints.create(
      "sbx_http",
      { port: 3000 },
      { idempotencyKey: "endpoint-http-key" },
    );
    await expect(
      client.endpoints.list("sbx_http", { cursor: "page-1", limit: 10 }),
    ).resolves.toMatchObject({ next_cursor: "page-2", endpoints: [{ id: "ep_http" }] });
    await expect(client.endpoints.revoke("sbx_http", "ep_http")).resolves.toMatchObject({
      state: "revoked",
    });

    const sseRequests = requests.filter(({ url }) => url?.endsWith("/proc_http/events"));
    expect(sseRequests.map(({ lastEventId }) => lastEventId)).toEqual([undefined, "1"]);
    expect(requests.find(({ url }) => url?.endsWith("/filesystem/write"))?.body).toMatchObject({
      data_base64: "AP+AQQ==",
    });
    expect(
      requests.every(
        ({ authorization, projectId }) =>
          authorization === "Bearer metal_sk_http" && projectId === "prj_http",
      ),
    ).toBe(true);
  });
});
