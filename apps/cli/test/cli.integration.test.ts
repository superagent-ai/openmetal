import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const executable =
  process.env.OPENMETAL_TEST_EXECUTABLE ??
  join(process.cwd(), "dist", process.platform === "win32" ? "openmetal.exe" : "openmetal");
const expectedVersion = (process.env.OPENMETAL_TEST_VERSION ?? "0.1.0-dev").replace(/^cli-v/, "");
const requests: Array<{
  url?: string;
  authorization?: string;
  projectId?: string;
  method?: string;
  body?: unknown;
}> = [];
let processExitCode = 0;
const binaryFixture = Buffer.from([0, 255, 128, 1, 10]);
const server = createServer(async (request, response) => {
  const requestRecord = {
    url: request.url,
    authorization: request.headers.authorization,
    projectId:
      typeof request.headers["x-metal-project-id"] === "string"
        ? request.headers["x-metal-project-id"]
        : undefined,
    method: request.method,
    body: undefined as unknown,
  };
  requests.push(requestRecord);
  const rawBody = await readBody(request);
  requestRecord.body = rawBody ? JSON.parse(rawBody) : undefined;
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/v1/organizations") {
    response.end(
      JSON.stringify({
        organizations: [
          {
            id: "2686e467-fcc4-4651-a7e1-3dc7c9c971cb",
            name: "Binary Test",
            slug: "binary-test",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    return;
  }
  if (request.url === "/v1/operations/op_test") {
    response.end(
      JSON.stringify({
        id: "op_test",
        project_id: "prj_test",
        type: "sandbox_create",
        state: "succeeded",
        resource_type: "sandbox",
        resource_id: "sbx_test",
        retryable: false,
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
        completed_at: "2026-01-01T00:00:01.000Z",
      }),
    );
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/processes" && request.method === "POST") {
    const body = requestRecord.body as { command?: string[] };
    processExitCode = body.command?.[0] === "false" ? 9 : 0;
    response.end(JSON.stringify(processFixture("queued", null)));
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/processes/proc_binary/events") {
    response.setHeader("content-type", "text/event-stream");
    response.end(processEventStream(processExitCode));
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/processes/proc_binary" && request.method === "GET") {
    response.end(
      JSON.stringify(
        processFixture(processExitCode === 0 ? "succeeded" : "failed", processExitCode),
      ),
    );
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/filesystem/write" && request.method === "POST") {
    response.end(JSON.stringify(runtimeOperation("rop_binarywrite", "filesystem_write", null)));
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/filesystem/read" && request.method === "POST") {
    response.end(JSON.stringify(runtimeOperation("rop_binaryread", "filesystem_read", null)));
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/runtime-operations/rop_binarywrite") {
    response.end(
      JSON.stringify(
        runtimeOperation("rop_binarywrite", "filesystem_write", {
          kind: "filesystem_write",
          path: "/workspace/binary.bin",
          bytes_written: binaryFixture.byteLength,
        }),
      ),
    );
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/runtime-operations/rop_binaryread") {
    response.end(
      JSON.stringify(
        runtimeOperation("rop_binaryread", "filesystem_read", {
          kind: "filesystem_read",
          path: "/workspace/binary.bin",
          data_base64: binaryFixture.toString("base64"),
          offset_bytes: 0,
          byte_length: binaryFixture.byteLength,
          eof: true,
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
    response.end(JSON.stringify({ endpoints: [endpointFixture("active")], next_cursor: null }));
    return;
  }
  if (request.url === "/v1/sandboxes/sbx_test/endpoints/ep_binary" && request.method === "DELETE") {
    response.end(JSON.stringify(endpointFixture("revoked")));
    return;
  }
  response.statusCode = 404;
  response.end(
    JSON.stringify({
      code: "not_found",
      message: "not found",
      request_id: "req_test",
      retryable: false,
    }),
  );
});
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("standalone binary", () => {
  it("starts without a runtime and calls the API", async () => {
    const { stdout } = await execFileAsync(executable, ["--json", "--api-url", baseUrl, "health"]);
    expect(JSON.parse(stdout)).toEqual({ status: "ok" });
  });

  it("embeds version metadata", async () => {
    const { stdout } = await execFileAsync(executable, ["--json", "version"]);
    expect(JSON.parse(stdout)).toMatchObject({
      version: expectedVersion,
      commit: "development",
    });
  });

  it("uses an access token for a real control-plane command", async () => {
    const { stdout } = await execFileAsync(executable, ["--json", "org", "list"], {
      env: {
        ...process.env,
        OPENMETAL_API_URL: baseUrl,
        OPENMETAL_ACCESS_TOKEN: "binary-user-token",
      },
    });
    expect(JSON.parse(stdout)).toMatchObject([{ name: "Binary Test" }]);
    expect(requests.find((request) => request.url === "/v1/organizations")?.authorization).toBe(
      "Bearer binary-user-token",
    );
  });

  it("uses project scope and API key for operation commands", async () => {
    const { stdout } = await execFileAsync(executable, ["--json", "operation", "get", "op_test"], {
      env: {
        ...process.env,
        OPENMETAL_API_URL: baseUrl,
        OPENMETAL_API_KEY: "metal_sk_binary",
        OPENMETAL_PROJECT_ID: "prj_test",
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({ id: "op_test", state: "succeeded" });
    expect(requests.find((request) => request.url === "/v1/operations/op_test")).toMatchObject({
      authorization: "Bearer metal_sk_binary",
      projectId: "prj_test",
    });
  });

  it("streams process output and passes command arguments as an array", async () => {
    const { stdout, stderr } = await execFileAsync(
      executable,
      ["sandbox", "exec", "sbx_test", "--", "printf", "hello; exit 99"],
      { env: projectEnvironment() },
    );

    expect(stdout).toBe("binary-out\n");
    expect(stderr).toBe("binary-err\n");
    const createRequest = requests.find(
      (request) => request.method === "POST" && request.url === "/v1/sandboxes/sbx_test/processes",
    );
    expect(createRequest).toMatchObject({
      authorization: "Bearer metal_sk_binary",
      projectId: "prj_test",
      body: { command: ["printf", "hello; exit 99"] },
    });
  });

  it("emits one JSON document and returns the remote process exit code", async () => {
    let failure: (Error & { code?: number; stdout?: string; stderr?: string }) | undefined;
    try {
      await execFileAsync(executable, ["--json", "sandbox", "exec", "sbx_test", "--", "false"], {
        env: projectEnvironment(),
      });
    } catch (error) {
      failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    }

    expect(failure?.code).toBe(9);
    expect(failure?.stderr).toBe("");
    expect(JSON.parse(failure?.stdout ?? "{}")).toMatchObject({
      process: { id: "proc_binary", exit_code: 9 },
    });
  });

  it("round-trips binary files through the standalone executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmetal-cli-binary-"));
    const source = join(directory, "source.bin");
    const destination = join(directory, "destination.bin");
    try {
      await writeFile(source, binaryFixture);
      await execFileAsync(
        executable,
        ["--json", "file", "upload", "sbx_test", source, "/workspace/binary.bin"],
        { env: projectEnvironment() },
      );
      await execFileAsync(
        executable,
        ["--json", "file", "download", "sbx_test", "/workspace/binary.bin", destination],
        { env: projectEnvironment() },
      );

      await expect(readFile(destination)).resolves.toEqual(binaryFixture);
      const uploadRequest = requests.find(
        (request) => request.url === "/v1/sandboxes/sbx_test/filesystem/write",
      );
      expect(uploadRequest?.body).toMatchObject({
        data_base64: binaryFixture.toString("base64"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes, paginates, and revokes endpoints with project authentication", async () => {
    const { stdout: exposed } = await execFileAsync(
      executable,
      ["--json", "endpoint", "expose", "sbx_test", "--port", "8080"],
      { env: projectEnvironment() },
    );
    const { stdout: listed } = await execFileAsync(
      executable,
      ["--json", "endpoint", "list", "sbx_test", "--cursor", "page-1", "--limit", "20"],
      { env: projectEnvironment() },
    );
    const { stdout: revoked } = await execFileAsync(
      executable,
      ["--json", "--no-input", "endpoint", "revoke", "sbx_test", "ep_binary", "--yes"],
      { env: projectEnvironment() },
    );

    expect(JSON.parse(exposed)).toMatchObject({ id: "ep_binary", state: "active" });
    expect(JSON.parse(listed)).toMatchObject({ endpoints: [{ id: "ep_binary" }] });
    expect(JSON.parse(revoked)).toMatchObject({ id: "ep_binary", state: "revoked" });
    const listRequest = requests.find((request) => request.url?.includes("cursor=page-1"));
    expect(listRequest).toMatchObject({
      authorization: "Bearer metal_sk_binary",
      projectId: "prj_test",
    });
    expect(listRequest?.url).toContain("limit=20");
  });

  it("keeps API failures on stderr with a failing exit code", async () => {
    let failure: (Error & { code?: number; stdout?: string; stderr?: string }) | undefined;
    try {
      await execFileAsync(executable, ["--json", "process", "get", "sbx_test", "proc_missing"], {
        env: projectEnvironment(),
      });
    } catch (error) {
      failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    }
    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toBe("");
    expect(failure?.stderr).toContain("not_found: not found");
    expect(failure?.stderr).toContain("request_id: req_test");
  });
});

function projectEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENMETAL_API_URL: baseUrl,
    OPENMETAL_API_KEY: "metal_sk_binary",
    OPENMETAL_PROJECT_ID: "prj_test",
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function processFixture(state: string, exitCode: number | null): Record<string, unknown> {
  return {
    id: "proc_binary",
    type: "process",
    project_id: "prj_test",
    sandbox_id: "sbx_test",
    state,
    command: ["printf", "binary-out"],
    cwd: null,
    timeout_seconds: 300,
    max_output_bytes: 10_485_760,
    output_bytes: 22,
    output_truncated: false,
    exit_code: exitCode,
    termination_signal: null,
    error: null,
    cancel_requested_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.100Z",
    completed_at: state === "queued" ? null : "2026-01-01T00:00:01.000Z",
  };
}

function processEventStream(exitCode: number): string {
  const event = (sequence: number, type: string, data: Record<string, unknown>) =>
    [
      `id: ${sequence}`,
      `event: ${type}`,
      `data: ${JSON.stringify({
        sequence,
        process_id: "proc_binary",
        occurred_at: "2026-01-01T00:00:01.000Z",
        type,
        data,
      })}`,
      "",
    ].join("\n");
  return [
    event(1, "queued", {}),
    event(2, "stdout", processOutput("binary-out\n")),
    event(3, "stderr", processOutput("binary-err\n")),
    event(4, "exited", { exit_code: exitCode }),
    "",
  ].join("\n");
}

function processOutput(value: string): Record<string, unknown> {
  return {
    data_base64: Buffer.from(value).toString("base64"),
    byte_length: Buffer.byteLength(value),
    stream_offset_bytes: 0,
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
    project_id: "prj_test",
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
    id: "ep_binary",
    type: "sandbox_endpoint",
    project_id: "prj_test",
    sandbox_id: "sbx_test",
    port: 8080,
    protocol: "http",
    state,
    url: state === "active" ? "https://binary.example.test" : null,
    lease_expires_at: "2026-01-01T01:00:00.000Z",
    revoked_at: state === "revoked" ? "2026-01-01T00:10:00.000Z" : null,
    error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:10:00.000Z",
  };
}
