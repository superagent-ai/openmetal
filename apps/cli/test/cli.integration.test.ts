import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const executable =
  process.env.OPENMETAL_TEST_EXECUTABLE ??
  join(process.cwd(), "dist", process.platform === "win32" ? "openmetal.exe" : "openmetal");
const requests: Array<{
  url?: string;
  authorization?: string;
  projectId?: string;
}> = [];
const server = createServer((request, response) => {
  requests.push({
    url: request.url,
    authorization: request.headers.authorization,
    projectId:
      typeof request.headers["x-metal-project-id"] === "string"
        ? request.headers["x-metal-project-id"]
        : undefined,
  });
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
  response.statusCode = 404;
  response.end(JSON.stringify({ code: "not_found", message: "not found", request_id: "req_test" }));
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
      version: "0.1.0-dev",
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
});
