import type { Account } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import { checkProfile, firstWrong, phoneTyped, saveOutcome } from "../src/profile-flow";

const account: Account = {
  id: "6f1c1d1e-0000-4000-8000-000000000001",
  email: "asha@example.com",
  name: "Asha Kulkarni",
  phone: "+919876543210",
};
const none = { name: false, phone: null, other: null };

describe("checkProfile", () => {
  it("sends the name and phone as the server stores them", () => {
    expect(checkProfile("  Asha   Kulkarni ", "98765 43210")).toEqual({
      body: { name: "Asha Kulkarni", phone: "+919876543210" },
    });
  });

  it("takes a pasted number with its +91 or a leading 0", () => {
    expect(checkProfile("Asha", "+91 98765-43210")).toEqual({ body: { name: "Asha", phone: "+919876543210" } });
    expect(checkProfile("Asha", "09876543210")).toEqual({ body: { name: "Asha", phone: "+919876543210" } });
  });

  it("marks each field that breaks its rule", () => {
    expect(checkProfile("", "12345")).toEqual({ problems: { ...none, name: true, phone: "invalid" } });
    expect(checkProfile("Asha 2", "98765 43210")).toEqual({ problems: { ...none, name: true } });
    expect(checkProfile("Asha", "")).toEqual({ problems: { ...none, phone: "invalid" } });
  });
});

describe("saveOutcome", () => {
  it("passes on the saved account", () => {
    expect(saveOutcome({ ok: true, data: account })).toEqual({ saved: account });
  });

  it("shows a phone in use under the phone", () => {
    expect(saveOutcome({ ok: false, status: 409, code: "PHONE_IN_USE" })).toEqual({
      problems: { ...none, phone: "in-use" },
    });
  });

  it("marks the fields the server refused", () => {
    expect(saveOutcome({ ok: false, status: 400, code: "VALIDATION_FAILED", fields: ["phone"] })).toEqual({
      problems: { ...none, phone: "invalid" },
    });
    expect(saveOutcome({ ok: false, status: 400, code: "VALIDATION_FAILED", fields: ["name", "phone"] })).toEqual({
      problems: { ...none, name: true, phone: "invalid" },
    });
  });

  it("shows a refusal that names no field of C02 under the button", () => {
    expect(saveOutcome({ ok: false, status: 400, code: "VALIDATION_FAILED" })).toEqual({
      problems: { ...none, other: "VALIDATION_FAILED" },
    });
    expect(saveOutcome({ ok: false, status: 400, code: "VALIDATION_FAILED", fields: ["extra"] })).toEqual({
      problems: { ...none, other: "VALIDATION_FAILED" },
    });
  });

  it("shows a server fault or no answer under the button", () => {
    expect(saveOutcome({ ok: false, status: 500, code: "INTERNAL" })).toEqual({ problems: { ...none, other: "INTERNAL" } });
    expect(saveOutcome("offline")).toEqual({ problems: { ...none, other: "offline" } });
  });
});

describe("firstWrong", () => {
  it("names the first wrong field, the name before the phone", () => {
    expect(firstWrong({ ...none, name: true, phone: "invalid" })).toBe("name");
    expect(firstWrong({ ...none, phone: "in-use" })).toBe("phone");
    expect(firstWrong({ ...none, other: "offline" })).toBeNull();
  });
});

describe("phoneTyped", () => {
  it("shows a saved phone without the +91 the box already shows", () => {
    expect(phoneTyped("+919876543210")).toBe("9876543210");
    expect(phoneTyped(null)).toBe("");
  });
});
