import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  Account,
  BrowserSession,
  ChangeNameBody,
  CreateAdminBody,
  ErrorEnvelope,
  invalidFields,
  RefreshBody,
  RequestCodeBody,
  Session,
  SetProfileBody,
  VerifyCodeBody,
} from "../src/index";

/** The fields a refused value names. */
function fieldsRefused(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the parse to fail");
  return invalidFields(result.error);
}

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com",
  name: "Asha Kulkarni",
  phone: "+919876543210",
};

describe("RequestCodeBody", () => {
  it("cleans the email", () => {
    expect(RequestCodeBody.parse({ email: " Asha@Example.com " })).toEqual({ email: "asha@example.com" });
  });

  it("names a bad email", () => {
    expect(fieldsRefused(RequestCodeBody, { email: "asha" })).toEqual(["email"]);
  });
});

describe("VerifyCodeBody", () => {
  it("accepts a 6-digit code typed with spaces", () => {
    expect(VerifyCodeBody.parse({ email: "asha@example.com", code: "123 456" })).toEqual({
      email: "asha@example.com",
      code: "123456",
    });
  });

  it("names a short code", () => {
    expect(fieldsRefused(VerifyCodeBody, { email: "asha@example.com", code: "12345" })).toEqual(["code"]);
  });
});

describe("RefreshBody", () => {
  it("accepts a token", () => {
    expect(RefreshBody.parse({ refreshToken: "abc" })).toEqual({ refreshToken: "abc" });
  });

  it("names an empty token", () => {
    expect(fieldsRefused(RefreshBody, { refreshToken: "" })).toEqual(["refreshToken"]);
  });

  it("names a token too long to be one of ours", () => {
    expect(fieldsRefused(RefreshBody, { refreshToken: "a".repeat(513) })).toEqual(["refreshToken"]);
  });
});

describe("SetProfileBody", () => {
  it("cleans the name and phone", () => {
    expect(SetProfileBody.parse({ name: "  Asha   Kulkarni ", phone: "98765 43210" })).toEqual({
      name: "Asha Kulkarni",
      phone: "+919876543210",
    });
  });

  it("names each bad field", () => {
    expect(fieldsRefused(SetProfileBody, { name: "4sha", phone: "12345" })).toEqual(["name", "phone"]);
  });
});

describe("ChangeNameBody", () => {
  it("accepts a name", () => {
    expect(ChangeNameBody.parse({ name: "Asha K" })).toEqual({ name: "Asha K" });
  });

  it("refuses a phone sent with it, since the phone changes only through support", () => {
    expect(fieldsRefused(ChangeNameBody, { name: "Asha K", phone: "+919876543210" })).toEqual(["phone"]);
  });
});

describe("Account", () => {
  it("accepts a full account", () => {
    expect(Account.parse(account)).toEqual(account);
  });

  it("accepts an account before the profile is set", () => {
    const fresh = { ...account, name: null, phone: null };
    expect(Account.parse(fresh)).toEqual(fresh);
  });

  it("keeps a name saved under an older, looser rule", () => {
    const older = { ...account, name: "Aaaa" };
    expect(Account.parse(older)).toEqual(older);
  });

  it("refuses an id that is not a UUID", () => {
    expect(Account.safeParse({ ...account, id: "42" }).success).toBe(false);
  });
});

describe("Session", () => {
  it("accepts both tokens and the account", () => {
    const session = { accessToken: "a", refreshToken: "r", account };
    expect(Session.parse(session)).toEqual(session);
  });

  it("refuses a session without a refresh token", () => {
    expect(Session.safeParse({ accessToken: "a", account }).success).toBe(false);
  });
});

describe("CreateAdminBody", () => {
  it("normalizes the shared fields and requires a reason", () => {
    expect(CreateAdminBody.parse({
      email: " Asha@Example.com ",
      name: " Asha   Kulkarni ",
      phone: "98765 43210",
      reason: "  Operations coverage  ",
    })).toEqual({
      email: "asha@example.com",
      name: "Asha Kulkarni",
      phone: "+919876543210",
      reason: "Operations coverage",
    });
  });

  it("names invalid fields and refuses an empty reason", () => {
    expect(fieldsRefused(CreateAdminBody, {
      email: "bad",
      name: "4sha",
      phone: "12345",
      reason: "   ",
    })).toEqual(["email", "name", "phone", "reason"]);
  });

  it("refuses unexpected account roles", () => {
    expect(fieldsRefused(CreateAdminBody, {
      email: account.email, name: account.name, phone: account.phone,
      reason: "Operations coverage", role: "area-manager",
    })).toEqual(["role"]);
  });
});

describe("BrowserSession", () => {
  it("accepts a browser-readable access token and account", () => {
    expect(BrowserSession.parse({ accessToken: "a", account })).toEqual({ accessToken: "a", account });
  });

  it("refuses a refresh token in the browser response", () => {
    expect(fieldsRefused(BrowserSession, { accessToken: "a", refreshToken: "r", account })).toEqual(["refreshToken"]);
  });
});

describe("sign-in error codes", () => {
  it.each([
    "UNAUTHENTICATED",
    "PROFILE_REQUIRED",
    "CODE_WRONG",
    "CODE_EXPIRED",
    "CODE_LOCKED",
    "TOO_MANY_REQUESTS",
    "PHONE_IN_USE",
    "EMAIL_IN_USE",
    "FORBIDDEN",
  ])("accepts %s", (code) => {
    expect(ErrorEnvelope.parse({ error: { code } })).toEqual({ error: { code } });
  });
});
