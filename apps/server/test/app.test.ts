import { ErrorEnvelope, HealthResponse } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("GET /v1/healthz", () => {
  it("answers ok when the database answers", async () => {
    const app = buildApp({ checkDatabase: async () => {} });
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
