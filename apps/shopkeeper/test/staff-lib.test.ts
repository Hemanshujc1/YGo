import { describe, expect, it } from "vitest";
import { codeRanOut, personLabel, readInvitePhone } from "../src/lib/staff";

describe("staff helpers (#535)", () => {
  it("names a person by name, else by number, else nothing", () => {
    expect(personLabel({ name: "Ravi", phone: "+919800000001" })).toBe("Ravi");
    expect(personLabel({ name: null, phone: "+919800000001" })).toBe("98000 00001");
    expect(personLabel({ name: null, phone: null })).toBe("");
  });

  it("reads a typed number the way the server stores it, and refuses what is not a mobile number", () => {
    for (const typed of ["9800000001", "09800000001", " 98000 00001 ", "+91 98000 00001", "919800000001"]) expect(readInvitePhone(typed), typed).toBe("+919800000001");
    for (const typed of ["", "  ", "12345", "98000000012", "abc"]) expect(readInvitePhone(typed), typed).toBeNull();
  });

  it("tells when a join code has run out", () => {
    const at = Date.parse("2030-01-02T00:00:00.000Z");
    expect(codeRanOut("2030-01-02T00:00:00.000Z", at)).toBe(true);
    expect(codeRanOut("2030-01-02T00:00:01.000Z", at)).toBe(false);
    expect(codeRanOut(null, at)).toBe(false);
  });
});
