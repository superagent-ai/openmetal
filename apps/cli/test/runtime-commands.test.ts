import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "../src/program.js";

type RecordedRequest = {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body?: unknown;
};

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runtime CLI commands", () => {
  it("executes argv without a shell and streams ordered stdout and stderr", async () => {
    const fixture = await runtimeApi({ exitCode: 0 });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(
        ["sandbox", "exec", "sbx_test", "--cwd", "/workspace", "--", "printf", "hello; rm -rf /"],
        runtime.value,
      ),
    ).resolves.toBe(0);

    expect(runtime.stdout()).toBe("first\nthird\n");
    expect(runtime.stderr()).toBe("second\n");
    expect(runtime.writes).toEqual([
      ["stdout", "first\n"],
      ["stderr", "second\n"],
      ["stdout", "third\n"],
    ]);
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/sandboxes/sbx_test/processes",
      body: {
        command: ["printf", "hello; rm -rf /"],
        cwd: "/workspace",
      },
    });
    expect(fixture.requests[0]?.headers).toMatchObject({
      authorization: "Bearer metal_sk_runtime",
      "x-metal-project-id": "prj_runtime",
    });
  });

  it("returns the remote exit code and keeps JSON as one document", async () => {
    const fixture = await runtimeApi({ exitCode: 7 });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["--json", "sandbox", "exec", "sbx_test", "--", "false"], runtime.value),
    ).resolves.toBe(7);

    const result = JSON.parse(runtime.stdout());
    expect(result.process).toMatchObject({ id: "proc_test", exit_code: 7 });
    expect(result.events).toHaveLength(5);
    expect(result.events.slice(0, 2)).toMatchObject([
      { sequence: 1, type: "queued" },
      { sequence: 2, type: "stdout" },
    ]);
    expect(runtime.stdout()).not.toContain("first\n");
    expect(runtime.stderr()).toBe("");
  });

  it("returns a nonzero remote exit code without adding synthetic stderr", async () => {
    const fixture = await runtimeApi({ exitCode: 7 });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["sandbox", "exec", "sbx_test", "--", "false"], runtime.value),
    ).resolves.toBe(7);

    expect(runtime.stdout()).toBe("first\nthird\n");
    expect(runtime.stderr()).toBe("second\n");
  });

  it("reports the accepted process ID and generated key when event streaming fails", async () => {
    const fixture = await runtimeApi({ exitCode: 0, eventFailure: true });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["sandbox", "exec", "sbx_test", "--", "printf", "hello"], runtime.value),
    ).resolves.toBe(1);

    const request = fixture.requests.find(
      ({ method, url }) => method === "POST" && url === "/v1/sandboxes/sbx_test/processes",
    );
    const idempotencyKey = request?.headers["idempotency-key"];
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.stderr()).toContain("upstream event stream failed");
    expect(runtime.stderr()).toContain("process_id: proc_test");
    expect(runtime.stderr()).toContain(`idempotency_key: ${String(idempotencyKey)}`);
  });

  it("reports the generated key when the process create connection fails after send", async () => {
    const fixture = await runtimeApi({ exitCode: 0, processCreateFailure: true });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["sandbox", "exec", "sbx_test", "--", "printf", "hello"], runtime.value),
    ).resolves.toBe(1);

    const request = fixture.requests.find(
      ({ method, url }) => method === "POST" && url === "/v1/sandboxes/sbx_test/processes",
    );
    const idempotencyKey = request?.headers["idempotency-key"];
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.stderr()).toContain(`idempotency_key: ${String(idempotencyKey)}`);
    expect(runtime.stderr()).not.toContain("metal_sk_runtime");
  });

  it("reports the accepted process ID and key when final status retrieval fails", async () => {
    const fixture = await runtimeApi({ exitCode: 0, processGetFailure: true });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["sandbox", "exec", "sbx_test", "--", "printf", "hello"], runtime.value),
    ).resolves.toBe(1);

    const request = fixture.requests.find(
      ({ method, url }) => method === "POST" && url === "/v1/sandboxes/sbx_test/processes",
    );
    const idempotencyKey = request?.headers["idempotency-key"];
    expect(runtime.stderr()).toContain("final process status failed");
    expect(runtime.stderr()).toContain("process_id: proc_test");
    expect(runtime.stderr()).toContain(`idempotency_key: ${String(idempotencyKey)}`);
  });

  it("supports process status, cancellation, and resumable events", async () => {
    const fixture = await runtimeApi({ exitCode: 0 });
    const getRuntime = testRuntime(fixture.baseUrl);
    const cancelRuntime = testRuntime(fixture.baseUrl);
    const eventsRuntime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["--json", "process", "get", "sbx_test", "proc_test"], getRuntime.value),
    ).resolves.toBe(0);
    await expect(
      runCli(
        ["--json", "--no-input", "process", "cancel", "sbx_test", "proc_test", "--yes"],
        cancelRuntime.value,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        ["--json", "process", "events", "sbx_test", "proc_test", "--after", "0"],
        eventsRuntime.value,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(getRuntime.stdout())).toMatchObject({ id: "proc_test" });
    expect(JSON.parse(cancelRuntime.stdout())).toMatchObject({ state: "cancelled" });
    expect(JSON.parse(eventsRuntime.stdout()).events).toHaveLength(5);
    const eventRequest = fixture.requests.find((request) => request.url?.endsWith("/events"));
    expect(eventRequest?.headers["last-event-id"]).toBe("0");
  });

  it("uploads and downloads binary files without UTF-8 conversion", async () => {
    const fixture = await runtimeApi({ exitCode: 0 });
    const directory = await mkdtemp(join(tmpdir(), "openmetal-runtime-cli-"));
    directories.push(directory);
    const source = join(directory, "source.bin");
    const destination = join(directory, "destination.bin");
    const bytes = Buffer.from([0, 255, 1, 128, 10, 13]);
    await writeFile(source, bytes);

    const uploadRuntime = testRuntime(fixture.baseUrl);
    await expect(
      runCli(
        ["--json", "file", "upload", "sbx_test", source, "/workspace/blob.bin", "--create-parents"],
        uploadRuntime.value,
      ),
    ).resolves.toBe(0);
    const writeRequest = fixture.requests.find((request) =>
      request.url?.endsWith("/filesystem/write"),
    );
    expect(writeRequest?.body).toMatchObject({
      path: "/workspace/blob.bin",
      data_base64: bytes.toString("base64"),
      create_parents: true,
    });

    const downloadRuntime = testRuntime(fixture.baseUrl);
    await expect(
      runCli(
        ["--json", "file", "download", "sbx_test", "/workspace/blob.bin", destination],
        downloadRuntime.value,
      ),
    ).resolves.toBe(0);
    await expect(readFile(destination)).resolves.toEqual(bytes);
    expect(JSON.parse(downloadRuntime.stdout())).toMatchObject({
      path: "/workspace/blob.bin",
      local_path: destination,
      byte_length: bytes.byteLength,
    });
  });

  it("reports the accepted runtime operation and generated key when append waiting fails", async () => {
    const fixture = await runtimeApi({ exitCode: 0, writeFailure: true });
    const directory = await mkdtemp(join(tmpdir(), "openmetal-runtime-cli-failure-"));
    directories.push(directory);
    const source = join(directory, "append.bin");
    await writeFile(source, Buffer.from([0, 255]));
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(
        ["file", "upload", "sbx_test", source, "/workspace/blob.bin", "--mode", "append"],
        runtime.value,
      ),
    ).resolves.toBe(1);

    const request = fixture.requests.find((entry) => entry.url?.endsWith("/filesystem/write"));
    const idempotencyKey = request?.headers["idempotency-key"];
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.stderr()).toContain("remote append failed");
    expect(runtime.stderr()).toContain("runtime_operation_id: rop_write");
    expect(runtime.stderr()).toContain(`idempotency_key: ${String(idempotencyKey)}`);
  });

  it("reports the generated key when the file write connection fails after send", async () => {
    const fixture = await runtimeApi({ exitCode: 0, writeCreateFailure: true });
    const directory = await mkdtemp(join(tmpdir(), "openmetal-runtime-cli-write-failure-"));
    directories.push(directory);
    const source = join(directory, "write.bin");
    await writeFile(source, Buffer.from([0, 255]));
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["file", "upload", "sbx_test", source, "/workspace/blob.bin"], runtime.value),
    ).resolves.toBe(1);

    const request = fixture.requests.find((entry) => entry.url?.endsWith("/filesystem/write"));
    const idempotencyKey = request?.headers["idempotency-key"];
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.stderr()).toContain(`idempotency_key: ${String(idempotencyKey)}`);
    expect(runtime.stderr()).not.toContain("metal_sk_runtime");
  });

  it("lists and deletes files and preserves destructive no-input handling", async () => {
    const fixture = await runtimeApi({ exitCode: 0 });
    const listRuntime = testRuntime(fixture.baseUrl);
    const deniedRuntime = testRuntime(fixture.baseUrl);
    const deleteRuntime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(
        ["--json", "file", "list", "sbx_test", "/workspace", "--max-entries", "25"],
        listRuntime.value,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(listRuntime.stdout())).toMatchObject({
      kind: "filesystem_list",
      entries: [{ path: "/workspace/blob.bin" }],
      truncated: true,
    });

    await expect(
      runCli(
        ["--no-input", "file", "delete", "sbx_test", "/workspace/blob.bin"],
        deniedRuntime.value,
      ),
    ).resolves.toBe(1);
    expect(deniedRuntime.stderr()).toContain("--yes");

    await expect(
      runCli(
        ["--json", "--no-input", "file", "delete", "sbx_test", "/workspace/blob.bin", "--yes"],
        deleteRuntime.value,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(deleteRuntime.stdout())).toMatchObject({
      kind: "filesystem_delete",
      deleted: true,
    });
  });

  it("exposes, paginates, and revokes endpoints", async () => {
    const fixture = await runtimeApi({ exitCode: 0 });
    const exposeRuntime = testRuntime(fixture.baseUrl);
    const listRuntime = testRuntime(fixture.baseUrl);
    const revokeRuntime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(
        ["--json", "endpoint", "expose", "sbx_test", "--port", "8080", "--lease-seconds", "600"],
        exposeRuntime.value,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        ["--json", "endpoint", "list", "sbx_test", "--cursor", "next-page", "--limit", "10"],
        listRuntime.value,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["--json", "endpoint", "revoke", "sbx_test", "ep_test", "--yes"], revokeRuntime.value),
    ).resolves.toBe(0);

    expect(
      fixture.requests.find(
        (request) => request.method === "POST" && request.url?.endsWith("/endpoints"),
      )?.body,
    ).toMatchObject({
      port: 8080,
      lease_seconds: 600,
    });
    expect(
      fixture.requests.find((request) => request.url?.includes("cursor=next-page"))?.url,
    ).toContain("limit=10");
    expect(JSON.parse(revokeRuntime.stdout())).toMatchObject({
      id: "ep_test",
      state: "revoked",
    });
  });

  it("uses existing API error rendering and failure codes", async () => {
    const fixture = await runtimeApi({ exitCode: 0 });
    const runtime = testRuntime(fixture.baseUrl);

    await expect(
      runCli(["--json", "process", "get", "sbx_test", "proc_missing"], runtime.value),
    ).resolves.toBe(1);
    expect(runtime.stdout()).toBe("");
    expect(runtime.stderr()).toContain("not_found: process not found");
    expect(runtime.stderr()).toContain("request_id: req_runtime");
  });
});

async function runtimeApi(options: {
  exitCode: number;
  eventFailure?: boolean;
  processCreateFailure?: boolean;
  processGetFailure?: boolean;
  writeCreateFailure?: boolean;
  writeFailure?: boolean;
}): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const binary = Buffer.from([0, 255, 1, 128, 10, 13]);
  const server = createServer(async (request, response) => {
    const rawBody = await readBody(request);
    const record: RecordedRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: rawBody.length ? JSON.parse(rawBody) : undefined,
    };
    requests.push(record);
    response.setHeader("content-type", "application/json");

    if (request.url === "/v1/sandboxes/sbx_test/processes" && request.method === "POST") {
      if (options.processCreateFailure) {
        response.destroy();
        return;
      }
      response.end(JSON.stringify(processFixture("queued", null)));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/processes/proc_test" && request.method === "GET") {
      if (options.processGetFailure) {
        response.statusCode = 502;
        response.end(
          JSON.stringify({
            code: "provider_error",
            message: "final process status failed",
            request_id: "req_process_status",
            retryable: false,
          }),
        );
        return;
      }
      response.end(
        JSON.stringify(
          processFixture(options.exitCode === 0 ? "succeeded" : "failed", options.exitCode),
        ),
      );
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/processes/proc_test" && request.method === "POST") {
      response.end(JSON.stringify(processFixture("cancelled", null)));
      return;
    }
    if (
      request.url === "/v1/sandboxes/sbx_test/processes/proc_test/actions/cancel" &&
      request.method === "POST"
    ) {
      response.end(JSON.stringify(processFixture("cancelled", null)));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/processes/proc_test/events") {
      if (options.eventFailure) {
        response.statusCode = 502;
        response.end(
          JSON.stringify({
            code: "provider_error",
            message: "upstream event stream failed",
            request_id: "req_stream",
            retryable: false,
          }),
        );
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      response.end(processEvents(options.exitCode));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/filesystem/write" && request.method === "POST") {
      if (options.writeCreateFailure) {
        response.destroy();
        return;
      }
      response.end(JSON.stringify(runtimeOperation("rop_write", "filesystem_write", null)));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/filesystem/read" && request.method === "POST") {
      response.end(JSON.stringify(runtimeOperation("rop_read", "filesystem_read", null)));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/filesystem/list" && request.method === "POST") {
      response.end(JSON.stringify(runtimeOperation("rop_list", "filesystem_list", null)));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/filesystem/delete" && request.method === "POST") {
      response.end(JSON.stringify(runtimeOperation("rop_delete", "filesystem_delete", null)));
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/runtime-operations/rop_write") {
      if (options.writeFailure) {
        response.end(
          JSON.stringify({
            ...runtimeOperation("rop_write", "filesystem_write", null),
            state: "failed",
            error: {
              code: "provider_error",
              message: "remote append failed",
              retryable: false,
            },
            started_at: "2026-01-01T00:00:00.100Z",
            completed_at: "2026-01-01T00:00:01.000Z",
          }),
        );
        return;
      }
      response.end(
        JSON.stringify(
          runtimeOperation("rop_write", "filesystem_write", {
            kind: "filesystem_write",
            path: "/workspace/blob.bin",
            bytes_written: binary.byteLength,
          }),
        ),
      );
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/runtime-operations/rop_read") {
      response.end(
        JSON.stringify(
          runtimeOperation("rop_read", "filesystem_read", {
            kind: "filesystem_read",
            path: "/workspace/blob.bin",
            data_base64: binary.toString("base64"),
            offset_bytes: 0,
            byte_length: binary.byteLength,
            eof: true,
          }),
        ),
      );
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/runtime-operations/rop_list") {
      response.end(
        JSON.stringify(
          runtimeOperation("rop_list", "filesystem_list", {
            kind: "filesystem_list",
            path: "/workspace",
            entries: [
              {
                path: "/workspace/blob.bin",
                type: "file",
                size_bytes: binary.byteLength,
                modified_at: "2026-01-01T00:00:00.000Z",
              },
            ],
            truncated: true,
          }),
        ),
      );
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/runtime-operations/rop_delete") {
      response.end(
        JSON.stringify(
          runtimeOperation("rop_delete", "filesystem_delete", {
            kind: "filesystem_delete",
            path: "/workspace/blob.bin",
            deleted: true,
          }),
        ),
      );
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/endpoints" && request.method === "POST") {
      response.end(JSON.stringify(endpointFixture("active")));
      return;
    }
    if (request.url?.startsWith("/v1/sandboxes/sbx_test/endpoints?") && request.method === "GET") {
      response.end(
        JSON.stringify({ endpoints: [endpointFixture("active")], next_cursor: "page-2" }),
      );
      return;
    }
    if (request.url === "/v1/sandboxes/sbx_test/endpoints/ep_test" && request.method === "DELETE") {
      response.end(JSON.stringify(endpointFixture("revoked")));
      return;
    }
    response.statusCode = 404;
    response.end(
      JSON.stringify({
        code: "not_found",
        message: "process not found",
        request_id: "req_runtime",
        retryable: false,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
  };
}

function processFixture(state: string, exitCode: number | null): Record<string, unknown> {
  return {
    id: "proc_test",
    type: "process",
    project_id: "prj_runtime",
    sandbox_id: "sbx_test",
    state,
    command: ["printf", "hello"],
    cwd: "/workspace",
    timeout_seconds: 300,
    max_output_bytes: 10_485_760,
    output_bytes: 19,
    output_truncated: false,
    exit_code: exitCode,
    termination_signal: null,
    error:
      exitCode !== null && exitCode !== 0
        ? {
            code: "process_exit_nonzero",
            message: `process exited with code ${exitCode}`,
            retryable: false,
          }
        : null,
    cancel_requested_at: state === "cancelled" ? "2026-01-01T00:00:01.000Z" : null,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.100Z",
    completed_at: state === "queued" ? null : "2026-01-01T00:00:01.000Z",
  };
}

function runtimeOperation(
  id: string,
  kind: string,
  result: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id,
    type: "runtime_operation",
    project_id: "prj_runtime",
    sandbox_id: "sbx_test",
    kind,
    state: result ? "succeeded" : "queued",
    result,
    error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: result ? "2026-01-01T00:00:00.100Z" : null,
    completed_at: result ? "2026-01-01T00:00:01.000Z" : null,
  };
}

function endpointFixture(state: "active" | "revoked"): Record<string, unknown> {
  return {
    id: "ep_test",
    type: "sandbox_endpoint",
    project_id: "prj_runtime",
    sandbox_id: "sbx_test",
    port: 8080,
    protocol: "http",
    state,
    url: state === "active" ? "https://ep.example.test" : null,
    lease_expires_at: "2026-01-01T01:00:00.000Z",
    revoked_at: state === "revoked" ? "2026-01-01T00:10:00.000Z" : null,
    error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:10:00.000Z",
  };
}

function processEvents(exitCode: number): string {
  const event = (sequence: number, type: string, data: Record<string, unknown>) =>
    [
      `id: ${sequence}`,
      `event: ${type}`,
      `data: ${JSON.stringify({
        sequence,
        process_id: "proc_test",
        occurred_at: "2026-01-01T00:00:01.000Z",
        type,
        data,
      })}`,
      "",
    ].join("\n");
  return [
    event(1, "queued", {}),
    event(2, "stdout", outputData("first\n", 0)),
    event(3, "stderr", outputData("second\n", 0)),
    event(4, "stdout", outputData("third\n", 6)),
    event(5, "exited", { exit_code: exitCode }),
    "",
  ].join("\n");
}

function outputData(value: string, offset: number): Record<string, unknown> {
  return {
    data_base64: Buffer.from(value).toString("base64"),
    byte_length: Buffer.byteLength(value),
    stream_offset_bytes: offset,
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function testRuntime(baseUrl: string): {
  value: CliRuntime;
  stdout: () => string;
  stderr: () => string;
  writes: Array<["stdout" | "stderr", string]>;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const writes: Array<["stdout" | "stderr", string]> = [];
  stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    writes.push(["stdout", chunk.toString()]);
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    writes.push(["stderr", chunk.toString()]);
  });
  Object.assign(stdout, { isTTY: false });
  Object.assign(stderr, { isTTY: false });
  const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: false });
  return {
    value: {
      env: {
        OPENMETAL_API_URL: baseUrl,
        OPENMETAL_API_KEY: "metal_sk_runtime",
        OPENMETAL_PROJECT_ID: "prj_runtime",
      },
      io: {
        stdin,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    },
    stdout: () => Buffer.concat(stdoutChunks).toString(),
    stderr: () => Buffer.concat(stderrChunks).toString(),
    writes,
  };
}
