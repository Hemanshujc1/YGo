import { describe, expect, it } from "vitest";
import { AppIdentity } from "../src/index";

describe("AppIdentity", () => {
  it("accepts each mobile app with a three-part version", () => {
    for (const name of ["customer", "shopkeeper"]) {
      expect(AppIdentity.parse({ name, version: "1.24.3" })).toEqual({ name, version: "1.24.3" });
    }
  });

  it("refuses an app the server does not version-check", () => {
    for (const name of ["admin", "web", "other"]) {
      expect(AppIdentity.safeParse({ name, version: "1.2.3" }).success).toBe(false);
    }
  });

  it("refuses a version that is not three numbers", () => {
    for (const version of ["", "1", "1.24", "1.2.3.4", "v1.2.3", "1.2.3-beta"]) {
      expect(AppIdentity.safeParse({ name: "customer", version }).success).toBe(false);
    }
  });
});
