import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postPinnedWebhook } from "../src/webhooks-node.js";

const execFileAsync = promisify(execFile);
const allowPrivate = { allowHttp: true, allowPrivateNetwork: true };
const strict = { allowHttp: false, allowPrivateNetwork: false };

type Captured = { host: string | undefined; url: string | undefined; body: string };

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("server did not bind a port"));
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

describe("pinned webhook transport", () => {
  const servers: Server[] = [];
  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function startRecorder(handler?: (captured: Captured) => void) {
    const captured: Captured[] = [];
    const server = createServer(async (request, response) => {
      const entry = {
        host: request.headers.host,
        url: request.url,
        body: await readBody(request),
      };
      captured.push(entry);
      handler?.(entry);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);
    servers.push(server);
    return { captured, port };
  }

  it("delivers to the validated IP while preserving Host, even if DNS rebinding occurs", async () => {
    const validated = await startRecorder();
    const rebound = await startRecorder();
    const response = await postPinnedWebhook({
      endpointUrl: `http://victim.example:${validated.port}/hook`,
      validatedIp: "127.0.0.1",
      headers: { "content-type": "application/json", "metal-delivery-id": "delivery-1" },
      body: JSON.stringify({ event_id: "event-1" }),
      policy: allowPrivate,
    });
    expect(response.status).toBe(200);
    // The connection went to the validated peer, never to a re-resolved address.
    expect(validated.captured).toHaveLength(1);
    expect(rebound.captured).toHaveLength(0);
    expect(validated.captured[0]).toMatchObject({
      host: `victim.example:${validated.port}`,
      url: "/hook",
      body: JSON.stringify({ event_id: "event-1" }),
    });
  });

  it("refuses to connect when the validated peer is private under a strict policy", async () => {
    const rebound = await startRecorder();
    await expect(
      postPinnedWebhook({
        endpointUrl: `http://victim.example:${rebound.port}/hook`,
        validatedIp: "169.254.169.254",
        headers: {},
        body: "{}",
        policy: strict,
      }),
    ).rejects.toThrow(/private/);
    expect(rebound.captured).toHaveLength(0);
  });

  it("refuses to dial an unvalidated hostname", async () => {
    await expect(
      postPinnedWebhook({
        endpointUrl: "https://victim.example/hook",
        validatedIp: "victim.example",
        headers: {},
        body: "{}",
        policy: strict,
      }),
    ).rejects.toThrow(/validated IP/);
  });

  it("surfaces redirects without following them", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 307;
      response.setHeader("location", "https://victim.example/elsewhere");
      response.end();
    });
    const port = await listen(server);
    servers.push(server);
    const response = await postPinnedWebhook({
      endpointUrl: `http://victim.example:${port}/hook`,
      validatedIp: "127.0.0.1",
      headers: {},
      body: "{}",
      policy: allowPrivate,
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://victim.example/elsewhere");
  });

  it("times out a hanging peer", async () => {
    const server = createServer(() => {});
    const port = await listen(server);
    servers.push(server);
    await expect(
      postPinnedWebhook({
        endpointUrl: `http://victim.example:${port}/hook`,
        validatedIp: "127.0.0.1",
        headers: {},
        body: "{}",
        policy: allowPrivate,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("pinned webhook TLS", () => {
  let caCert = "";
  let serverKey = "";
  let serverCert = "";
  let tlsServer: Server | undefined;
  let tlsPort = 0;
  let observedSni: string | undefined;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "webhook-tls-"));
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      join(dir, "ca.key"),
      "-out",
      join(dir, "ca.crt"),
      "-days",
      "2",
      "-nodes",
      "-subj",
      "/CN=Metal Webhook Test CA",
    ]);
    await execFileAsync("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-keyout",
      join(dir, "server.key"),
      "-out",
      join(dir, "server.csr"),
      "-nodes",
      "-subj",
      "/CN=webhook.example",
    ]);
    await writeFile(join(dir, "san.ext"), "subjectAltName=DNS:webhook.example\n");
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      join(dir, "server.csr"),
      "-CA",
      join(dir, "ca.crt"),
      "-CAkey",
      join(dir, "ca.key"),
      "-CAcreateserial",
      "-out",
      join(dir, "server.crt"),
      "-days",
      "2",
      "-extfile",
      join(dir, "san.ext"),
    ]);
    [caCert, serverKey, serverCert] = await Promise.all(
      [join(dir, "ca.crt"), join(dir, "server.key"), join(dir, "server.crt")].map((file) =>
        readFile(file, "utf8"),
      ),
    );
    tlsServer = createTlsServer({ key: serverKey, cert: serverCert }, (socket) => {
      observedSni = (socket as TLSSocket).servername;
      socket.on("data", () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}',
        );
      });
    });
    tlsPort = await listen(tlsServer);
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => tlsServer?.close(() => resolve()) ?? resolve());
  });

  it("verifies the chain for the original hostname and sends its SNI to the pinned IP", async () => {
    const response = await postPinnedWebhook({
      endpointUrl: `https://webhook.example:${tlsPort}/hook`,
      validatedIp: "127.0.0.1",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: "event-1" }),
      policy: { allowHttp: false, allowPrivateNetwork: true },
      tls: { ca: caCert },
    });
    expect(response.status).toBe(200);
    expect(observedSni).toBe("webhook.example");
  });

  it("rejects a peer whose certificate does not chain to a trusted CA", async () => {
    await expect(
      postPinnedWebhook({
        endpointUrl: `https://webhook.example:${tlsPort}/hook`,
        validatedIp: "127.0.0.1",
        headers: {},
        body: "{}",
        policy: strict,
      }),
    ).rejects.toThrow();
  });
});
