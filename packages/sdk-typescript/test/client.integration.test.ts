import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { MetalClient } from "../src/index.js";

describe("MetalClient HTTP integration", () => {
  let server: Server;
  let baseUrl = "";
  const authorizationHeaders: Array<string | undefined> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
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
                id: "11111111-1111-4111-8111-111111111111",
                name: "HTTP Org",
                slug: "http-org",
                created_at: "2026-08-20T12:00:00.000Z",
                updated_at: "2026-08-20T12:00:00.000Z",
              },
            ],
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          code: "not_found",
          message: "route not found",
          request_id: "req_http",
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP test server did not expose an address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("uses real HTTP, sends the refreshed token, and validates responses", async () => {
    let token = "first-token";
    const client = new MetalClient({
      baseUrl,
      accessToken: async () => token,
    });

    await expect(client.health()).resolves.toEqual({ status: "ok" });
    token = "refreshed-token";
    await expect(client.organizations.list()).resolves.toMatchObject({
      organizations: [{ name: "HTTP Org" }],
    });
    expect(authorizationHeaders).toEqual(["Bearer first-token", "Bearer refreshed-token"]);
  });
});
