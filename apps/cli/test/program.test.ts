import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runCli, type CliRuntime } from "../src/program.js";

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
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI commands", () => {
  it("calls unauthenticated health and emits JSON", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({ OPENMETAL_API_URL: baseUrl });

    await expect(runCli(["--json", "health"], runtime.value)).resolves.toBe(0);
    expect(runtime.stdout.read()?.toString()).toContain('"status": "ok"');
    expect(requests[0]?.url).toBe("/health");
  });

  it("uses a user token for control-plane commands", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_ACCESS_TOKEN: "user-token",
    });

    await expect(runCli(["--json", "org", "list"], runtime.value)).resolves.toBe(0);
    expect(requests[0]?.headers.authorization).toBe("Bearer user-token");
    expect(runtime.stdout.read()?.toString()).toContain("Test Organization");
  });

  it("prefers an access-token flag over the environment", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_ACCESS_TOKEN: "environment-token",
    });

    await expect(
      runCli(["--access-token", "flag-token", "--json", "org", "list"], runtime.value),
    ).resolves.toBe(0);
    expect(requests[0]?.headers.authorization).toBe("Bearer flag-token");
  });

  it("uses project credentials for operation commands", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_API_KEY: "metal_sk_test",
      OPENMETAL_PROJECT_ID: "prj_test",
    });

    await expect(runCli(["--json", "operation", "get", "op_test"], runtime.value)).resolves.toBe(0);
    expect(requests[0]?.headers.authorization).toBe("Bearer metal_sk_test");
    expect(requests[0]?.headers["x-metal-project-id"]).toBe("prj_test");
  });

  it("resumes operation event batches with Last-Event-ID", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_API_KEY: "metal_sk_test",
      OPENMETAL_PROJECT_ID: "prj_test",
    });

    await expect(
      runCli(["--json", "operation", "events", "op_test", "--after", "4"], runtime.value),
    ).resolves.toBe(0);
    expect(requests[0]?.headers["last-event-id"]).toBe("4");
    expect(runtime.stdout.read()?.toString()).toContain('"sequence": 5');
  });

  it("persists context options when they are parsed as global options", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "openmetal-program-"));
    directories.push(configHome);
    const env = { OPENMETAL_CONFIG_HOME: configHome };
    const runtime = testRuntime(env);

    await expect(
      runCli(
        ["context", "use", "--organization", "org_expected", "--project", "prj_expected"],
        runtime.value,
      ),
    ).resolves.toBe(0);

    await expect(loadConfig(env)).resolves.toMatchObject({
      profiles: {
        default: {
          organizationId: "org_expected",
          projectId: "prj_expected",
        },
      },
    });
  });

  it("persists colliding config options", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "openmetal-program-"));
    directories.push(configHome);
    const env = { OPENMETAL_CONFIG_HOME: configHome };
    const runtime = testRuntime(env);

    await expect(
      runCli(
        [
          "config",
          "set",
          "--api-url",
          "https://api.example.test",
          "--organization",
          "org_expected",
          "--project",
          "prj_expected",
        ],
        runtime.value,
      ),
    ).resolves.toBe(0);

    await expect(loadConfig(env)).resolves.toMatchObject({
      profiles: {
        default: {
          apiUrl: "https://api.example.test",
          organizationId: "org_expected",
          projectId: "prj_expected",
        },
      },
    });
  });

  it("returns a failure exit code for failed operations", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_API_KEY: "metal_sk_test",
      OPENMETAL_PROJECT_ID: "prj_test",
    });

    await expect(runCli(["--json", "operation", "wait", "op_failed"], runtime.value)).resolves.toBe(
      1,
    );
    expect(JSON.parse(runtime.stdout.read()?.toString() ?? "{}")).toMatchObject({
      id: "op_failed",
      state: "failed",
    });
    expect(runtime.stderr.read()?.toString()).toContain("no eligible provider");
  });

  it("emits one structured document when a watched operation fails", async () => {
    const requests: IncomingMessage[] = [];
    const baseUrl = await fakeApi(requests);
    const runtime = testRuntime({
      OPENMETAL_API_URL: baseUrl,
      OPENMETAL_API_KEY: "metal_sk_test",
      OPENMETAL_PROJECT_ID: "prj_test",
    });

    await expect(runCli(["operation", "watch", "op_failed"], runtime.value)).resolves.toBe(1);
    const result = JSON.parse(runtime.stdout.read()?.toString() ?? "{}");
    expect(result).toMatchObject({
      events: [{ sequence: 1, type: "completed" }],
      operation: { id: "op_failed", state: "failed" },
    });
    expect(runtime.stderr.read()?.toString()).toContain("no eligible provider");
  });
});

async function fakeApi(requests: IncomingMessage[]): Promise<string> {
  const server = createServer((request, response) => {
    requests.push(request);
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
              name: "Test Organization",
              slug: "test",
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
    if (request.url === "/v1/operations/op_test/events") {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        [
          "id: 5",
          "event: completed",
          `data: ${JSON.stringify({
            sequence: 5,
            operation_id: "op_test",
            type: "completed",
            occurred_at: "2026-01-01T00:00:01.000Z",
            data: {},
          })}`,
          "",
          "",
        ].join("\n"),
      );
      return;
    }
    if (request.url === "/v1/operations/op_failed") {
      response.end(
        JSON.stringify({
          id: "op_failed",
          project_id: "prj_test",
          type: "sandbox_create",
          state: "failed",
          resource_type: "sandbox",
          resource_id: "sbx_failed",
          retryable: false,
          error: {
            code: "no_eligible_provider",
            message: "no eligible provider",
            retryable: false,
          },
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
          completed_at: "2026-01-01T00:00:01.000Z",
        }),
      );
      return;
    }
    if (request.url === "/v1/operations/op_failed/events") {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        [
          "id: 1",
          "event: completed",
          `data: ${JSON.stringify({
            sequence: 1,
            operation_id: "op_failed",
            type: "completed",
            occurred_at: "2026-01-01T00:00:01.000Z",
            data: { state: "failed" },
          })}`,
          "",
          "",
        ].join("\n"),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found", message: "not found", request_id: "req" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function testRuntime(env: Record<string, string>): {
  value: CliRuntime;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(stdout, { isTTY: false });
  Object.assign(stderr, { isTTY: false });
  const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: false });
  return {
    value: {
      env,
      io: {
        stdin,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    },
    stdout,
    stderr,
  };
}
