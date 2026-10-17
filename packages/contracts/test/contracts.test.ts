import { describe, expect, it } from "vitest";
import { ErrorEnvelope, HealthResponse } from "../src/index";

describe("ErrorEnvelope", () => {
  it("accepts a known machine code", () => {
    expect(ErrorEnvelope.parse({ error: { code: "NOT_FOUND" } })).toEqual({
      error: { code: "NOT_FOUND" },
    });
  });

  it("rejects a code that is not in the list", () => {
    expect(ErrorEnvelope.safeParse({ error: { code: "TEAPOT" } }).success).toBe(false);
  });

  it("carries the fields that failed validation", () => {
    const body = { error: { code: "VALIDATION_FAILED", fields: ["phone", "address.pincode"] } };
    expect(ErrorEnvelope.parse(body)).toEqual(body);
  });

  it("drops display text instead of passing it on", () => {
    const parsed = ErrorEnvelope.parse({ error: { code: "INTERNAL", message: "Something broke" } });
    expect(parsed).toEqual({ error: { code: "INTERNAL" } });
  });
});

describe("HealthResponse", () => {
  it("accepts ok", () => {
    expect(HealthResponse.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects any other status", () => {
    expect(HealthResponse.safeParse({ status: "degraded" }).success).toBe(false);
  });
});
