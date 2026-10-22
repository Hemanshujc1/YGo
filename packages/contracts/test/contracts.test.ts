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

  it("carries each pincode another Area holds", () => {
    const body = { error: { code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411038", areaName: "Kothrud" }] } };
    expect(ErrorEnvelope.parse(body)).toEqual(body);
  });

  it("accepts a taken Area name", () => {
    expect(ErrorEnvelope.parse({ error: { code: "AREA_NAME_IN_USE" } })).toEqual({ error: { code: "AREA_NAME_IN_USE" } });
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
