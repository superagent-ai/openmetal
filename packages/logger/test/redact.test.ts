import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../src/logger.js";
import { REDACTED, redactRecord, redactString } from "../src/redact.js";

describe("logger redaction", () => {
  it("redacts authorization headers", () => {
    expect(redactRecord({ authorization: "Bearer secret-token" })).toEqual({
      authorization: REDACTED,
    });
    expect(redactString("request failed with Bearer secret-token")).toBe(REDACTED);
  });

  it("redacts cookies", () => {
    expect(redactRecord({ cookie: "sb-access-token=abc" }).cookie).toBe(REDACTED);
    expect(redactRecord({ headers: { Cookie: "a=b" } }).headers).toEqual({ Cookie: REDACTED });
  });

  it("redacts supabase access and refresh tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.s1";
    expect(redactString(jwt)).toBe(REDACTED);
    expect(redactRecord({ access_token: jwt, refresh_token: "rt_1" })).toEqual({
      access_token: REDACTED,
      refresh_token: REDACTED,
    });
  });

  it("redacts publishable, secret, and legacy keys", () => {
    expect(redactString("sb_publishable_abcDEF123")).toBe(REDACTED);
    expect(redactString("sb_secret_abcDEF123")).toBe(REDACTED);
    expect(redactRecord({ SUPABASE_SECRET_KEY: "service_role" }).SUPABASE_SECRET_KEY).toBe(
      REDACTED,
    );
  });

  it("redacts database urls", () => {
    expect(redactString("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe(REDACTED);
    expect(redactRecord({ DATABASE_URL: "postgres://x:y@localhost/db" }).DATABASE_URL).toBe(
      REDACTED,
    );
  });

  it("redacts api keys and signed urls", () => {
    expect(redactString("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(REDACTED);
    expect(redactString("https://storage.example.com/file?token=abc&signature=deadbeef")).toBe(
      REDACTED,
    );
  });

  it("redacts provider credentials and known secret env vars", () => {
    expect(redactRecord({ provider_credential: "daytona-token" }).provider_credential).toBe(
      REDACTED,
    );
    expect(redactRecord({ PROVIDER_API_KEY: "modal-key" }).PROVIDER_API_KEY).toBe(REDACTED);
  });

  it("keeps non-secret operational fields", () => {
    expect(
      redactRecord({
        request_id: "req_1",
        service: "api",
        organization_id: "11111111-1111-4111-8111-111111111111",
        path: "/v1/organizations",
        status_code: 201,
      }),
    ).toMatchObject({
      request_id: "req_1",
      path: "/v1/organizations",
      status_code: 201,
    });
  });

  it("redacts representative secrets in emitted structured logs", () => {
    const output: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger({
      service: "validation",
      level: "info",
      destination,
    });
    logger.error({
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=secret-cookie",
      },
      DATABASE_URL: "postgresql://user:password@localhost/database",
      url: "https://storage.example/file?token=signed-secret",
      path: "/v1/events?token=query-secret",
      job: {
        payload: {
          api_key: "sk-abcdefghijklmnopqrstuvwxyz123456",
        },
      },
      request_id: "req_safe",
    });

    const serialized = output.join("");
    expect(serialized).toContain("req_safe");
    expect(serialized).toContain(REDACTED);
    expect(serialized).not.toMatch(
      /secret-token|secret-cookie|user:password|signed-secret|query-secret|sk-abcdefghijklmnopqrstuvwxyz123456/,
    );
  });
});
