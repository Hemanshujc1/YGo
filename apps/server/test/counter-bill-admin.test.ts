import { describe, expect, it } from "vitest";
import { readableInvalidPayload } from "../src/counter-bill-admin";

const pack = "0f3a91bc-0000-4000-8000-000000000001";
const shown = (payload: unknown) => JSON.parse(readableInvalidPayload(JSON.stringify(payload)) ?? "") as unknown;

describe("readableInvalidPayload (#53)", () => {
  it("keeps the bill's keys and its figures, hides the customer and a typed line's name", () => {
    expect(shown({ lines: [{ packId: pack, count: 1, unitPrice: "5" }], manualLines: [{ name: "Rope", count: 2, unitPrice: "30" }], discount: "5", total: "25", payment: "upi",
      customer: { name: "Meera", phone: "+919876543210", offers: true }, other: "x" })).toEqual({
      lines: [{ packId: pack, count: 1, unitPrice: "5" }], manualLines: [{ name: "[hidden]", count: 2, unitPrice: "30" }], discount: "5", total: "25", payment: "upi",
      "[hidden key 6]": "[hidden]", "[hidden key 7]": "[hidden]" });
  });

  it("hides customer data placed in a known key's value or in a line, whatever the key's case", () => {
    const out = readableInvalidPayload(JSON.stringify({ lines: [{ packId: pack, count: 1, unitPrice: "5", customerPhone: "+919876543210", Customer: { name: "Meera" }, buyer: "Meera", phone: 9876543210 }],
      payment: "Meera 9876543210", total: "+919876543210", discount: { name: "Meera" }, createdAt: "2030-01-01T9876543210Z", manualLines: [{ name: "Meera", count: "Meera", unitPrice: "9876543210a", packId: pack }, "Meera"] })) ?? "";
    for (const secret of ["Meera", "9876543210", "Customer", "buyer", "phone"]) expect(out).not.toContain(secret);
    expect(JSON.parse(out)).toMatchObject({ lines: [{ packId: pack, count: 1, unitPrice: "5", "[hidden key 4]": "[hidden]", "[hidden key 5]": "[hidden]", "[hidden key 6]": "[hidden]" }], payment: "[hidden]", total: "[hidden]", discount: "[hidden]", "[hidden key 5]": "[hidden]",
      manualLines: [{ name: "[hidden]", count: "[hidden]", unitPrice: "[hidden]", packId: "[hidden]" }, "[hidden]"] });
  });

  it("hides a phone number sent as digits, with or without a dot, in an amount or a count, or in a time, and keeps an amount a shop could sell", () => {
    expect(shown({ lines: [{ packId: pack, count: 9876543210, unitPrice: "919876543210" }, { packId: pack, count: 999999, unitPrice: "999999.999" }], total: "9876543.210", discount: "98765432.10" })).toEqual({
      lines: [{ packId: pack, count: "[hidden]", unitPrice: "[hidden]" }, { packId: pack, count: 999999, unitPrice: "999999.999" }], total: "[hidden]", discount: "[hidden]" });
    expect(shown({ total: "9876543210" })).toEqual({ total: "[hidden]" });
  });

  it("hides a wrongly shaped known key whole and survives a payload nested far deeper than the stack", () => {
    expect(readableInvalidPayload(`{"lines":${"[".repeat(20000)}"Meera"${"]".repeat(20000)},"total":"1"}`)).toBe('{"lines":["[hidden]"],"total":"1"}');
    expect(shown({ lines: "Meera", manualLines: { name: "Meera" } })).toEqual({ lines: "[hidden]", manualLines: "[hidden]" });
  });

  it("hides a key named for the customer or odd like __proto__, and a NUL or lone surrogate in a value", () => {
    expect(readableInvalidPayload('{"__proto__":"x","+919876543210":1,"payment":"cash\\u0000","total":"\\ud800"}')).toBe('{"[hidden key 1]":"[hidden]","[hidden key 2]":"[hidden]","payment":"[hidden]","total":"[hidden]"}');
  });

  it("hides text that is not a JSON object whole, and passes null through", () => {
    expect(readableInvalidPayload("Meera +919876543210")).toBe("[hidden]");
    expect(readableInvalidPayload('["Meera"]')).toBe("[hidden]");
    expect(readableInvalidPayload('"Meera"')).toBe("[hidden]");
    expect(readableInvalidPayload(null)).toBeNull();
  });
});
