import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Email,
  FssaiNumber,
  HandoverOtp,
  invalidFields,
  LoginOtp,
  Pan,
  PersonName,
  Phone,
  Pincode,
  UpiId,
} from "../src/index";

/** Checks that each typed value is accepted and stored as given, and each refused value fails. */
function rule(
  schema: z.ZodType<string>,
  accepts: Record<string, string>,
  refuses: string[],
) {
  for (const [typed, stored] of Object.entries(accepts)) {
    it(`accepts ${JSON.stringify(typed)}`, () => {
      expect(schema.parse(typed)).toBe(stored);
    });
  }
  for (const typed of refuses) {
    it(`refuses ${JSON.stringify(typed)}`, () => {
      expect(schema.safeParse(typed).success).toBe(false);
    });
  }
}

describe("Phone", () => {
  rule(
    Phone,
    {
      "9876543210": "+919876543210",
      "98765 43210": "+919876543210",
      "+91 98765-43210": "+919876543210",
      "919876543210": "+919876543210",
      "09876543210": "+919876543210",
      "(987) 654 3210": "+919876543210",
      "6000000000": "+916000000000",
    },
    ["", "5876543210", "987654321", "98765432101", "+1 2025550123", "98765abcde", "+9198765432"],
  );
});

describe("PersonName", () => {
  rule(
    PersonName,
    {
      "Asha": "Asha",
      "  Asha   Kulkarni ": "Asha Kulkarni",
      "हेमांशु": "हेमांशु",
      "D'Souza": "D'Souza",
      "D’Souza": "D’Souza",
      "Mary-Ann": "Mary-Ann",
      "K. Ramesh": "K. Ramesh",
      "A": "A",
      [`${"a".repeat(60)}`]: "a".repeat(60),
    },
    ["", "   ", "Asha2", "Asha 🙂", "...", "a".repeat(61), "Asha@home"],
  );
});

describe("Email", () => {
  rule(
    Email,
    { " Asha@Example.COM ": "asha@example.com" },
    ["", "asha", "asha@", "@example.com", "asha example@x.com"],
  );
});

describe("LoginOtp", () => {
  rule(LoginOtp, { "123456": "123456", "123 456": "123456" }, ["", "12345", "1234567", "12345a"]);
});

describe("HandoverOtp", () => {
  rule(HandoverOtp, { "0427": "0427" }, ["", "427", "04271", "04a7"]);
});

describe("Pincode", () => {
  rule(Pincode, { "411001": "411001", "411 001": "411001" }, ["", "011001", "41100", "4110011", "41100a"]);
});

describe("Pan", () => {
  rule(Pan, { "abcpe1234f": "ABCPE1234F", "ABCPE 1234 F": "ABCPE1234F" }, ["", "ABCPE1234", "ABCP11234F", "1BCPE1234F"]);
});

describe("FssaiNumber", () => {
  rule(FssaiNumber, { "12345678901234": "12345678901234" }, ["", "1234567890123", "123456789012345", "1234567890123a"]);
});

describe("UpiId", () => {
  rule(
    UpiId,
    { "Asha.K@OKHDFCBANK": "asha.k@okhdfcbank", "9876543210@ybl": "9876543210@ybl" },
    ["", "asha", "asha@", "a@ybl", "asha@1bank", "asha k@ybl"],
  );
});

describe("invalidFields", () => {
  const Request = z.object({ name: PersonName, address: z.object({ pincode: Pincode }) });
  const errorOf = (value: unknown) => {
    const result = Request.safeParse(value);
    if (result.success) throw new Error("expected the parse to fail");
    return result.error;
  };

  it("names each failing field once, by its dot path", () => {
    expect(invalidFields(errorOf({ name: "", address: { pincode: "0" } }))).toEqual([
      "name",
      "address.pincode",
    ]);
  });

  it("names no field when the whole value is wrong", () => {
    expect(invalidFields(errorOf("not an object"))).toEqual([]);
  });
});
