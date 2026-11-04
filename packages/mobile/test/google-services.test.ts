import { describe, expect, it } from "vitest";
import googleServices from "../google-services.config";

describe("googleServices (#506, #507)", () => {
  it("passes the path through, and leaves Firebase out when it is missing or empty", () => {
    expect(googleServices({ GOOGLE_SERVICES_JSON: "./google-services.json" })).toEqual({ googleServicesFile: "./google-services.json" });
    expect(googleServices({})).toEqual({});
    expect(googleServices({ GOOGLE_SERVICES_JSON: "" })).toEqual({});
  });
});
