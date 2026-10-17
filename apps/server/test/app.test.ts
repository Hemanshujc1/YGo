import { ErrorEnvelope, HealthResponse } from "@ygo/contracts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app";
import { connectDatabase } from "../src/db";

const database = connectDatabase(inject("databaseUrl"));
afterAll(() => database.close());

describe("GET /v1/healthz", () => {
  it("answers ok when the database answers", async () => {
    const app = buildApp({ checkDatabase: database.ping });
    const res = await app.inject({ method: "GET", url: "/v1/healthz" });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({ status: "ok" });
  });

  it("answers 503 UNAVAILABLE when the database does not", async () => {
    const app = buildApp({
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/healthz" });
    expect(res.statusCode).toBe(503);
    expect(ErrorEnvelope.parse(res.json())).toEqual({ error: { code: "UNAVAILABLE" } });
  });
});

describe("errors", () => {
  it("answers an unknown route with the NOT_FOUND envelope", async () => {
    const app = buildApp({ checkDatabase: async () => {} });
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND" } });
  });
});

describe("a request body that breaks its schema", () => {
  it("answers 400 VALIDATION_FAILED naming the fields", async () => {
    const app = buildApp({ checkDatabase: async () => {} });
    app.post("/v1/echo", { schema: { body: HealthResponse } }, async () => ({}));
    const res = await app.inject({ method: "POST", url: "/v1/echo", payload: { status: "no" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["status"] } });
  });

  it("names no field when the body is not JSON", async () => {
    const app = buildApp({ checkDatabase: async () => {} });
    app.post("/v1/echo", { schema: { body: HealthResponse } }, async () => ({}));
    const res = await app.inject({
      method: "POST",
      url: "/v1/echo",
      payload: "{",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION_FAILED" } });
  });
});

describe("the test database", () => {
  it("has the migrations applied", async () => {
    const { rows } = await database.pool.query("select postgis_version()");
    expect(rows).toHaveLength(1);
  });
});
