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

describe("the app version check", () => {
  const minAppVersions = { customer: "1.4.0", shopkeeper: "2.0.0" };

  function appWithRoute() {
    const app = buildApp({ checkDatabase: async () => {}, minAppVersions });
    app.get("/v1/ping", async () => ({}));
    return app;
  }

  const ping = (headers: Record<string, string>) =>
    appWithRoute().inject({ method: "GET", url: "/v1/ping", headers });

  it.each([
    ["customer", "1.3.9"],
    ["customer", "0.9.0"],
    ["shopkeeper", "1.9.9"],
  ])("answers a too-old %s app %s with 426 UPDATE_REQUIRED", async (name, version) => {
    const res = await ping({ "x-ygo-app-name": name, "x-ygo-app-version": version });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toEqual({ error: { code: "UPDATE_REQUIRED" } });
  });

  it.each([
    ["customer", "1.4.0"],
    ["customer", "1.10.0"],
    ["shopkeeper", "2.0.0"],
    ["shopkeeper", "10.0.0"],
  ])("serves %s app %s", async (name, version) => {
    const res = await ping({ "x-ygo-app-name": name, "x-ygo-app-version": version });
    expect(res.statusCode).toBe(200);
  });

  it("serves a request with no app headers", async () => {
    const res = await ping({});
    expect(res.statusCode).toBe(200);
  });

  it("serves healthz to a too-old app", async () => {
    const res = await appWithRoute().inject({
      method: "GET",
      url: "/v1/healthz",
      headers: { "x-ygo-app-name": "customer", "x-ygo-app-version": "0.0.1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [{ "x-ygo-app-name": "customer", "x-ygo-app-version": "abc" }],
    [{ "x-ygo-app-name": "admin", "x-ygo-app-version": "9.0.0" }],
    [{ "x-ygo-app-name": "customer" }],
    [{ "x-ygo-app-version": "1.4.0" }],
  ])("answers broken app headers %o with 400 VALIDATION_FAILED", async (headers) => {
    const res = await ping(headers);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION_FAILED" } });
  });

  it("refuses none by default", async () => {
    const app = buildApp({ checkDatabase: async () => {} });
    app.get("/v1/ping", async () => ({}));
    const res = await app.inject({
      method: "GET",
      url: "/v1/ping",
      headers: { "x-ygo-app-name": "shopkeeper", "x-ygo-app-version": "0.0.0" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("the test database", () => {
  it("has the migrations applied", async () => {
    const { rows } = await database.pool.query("select postgis_version()");
    expect(rows).toHaveLength(1);
  });
});
