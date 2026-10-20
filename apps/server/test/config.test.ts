import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const database = { DATABASE_URL: "postgres://ygo:ygo@localhost:5432/ygo" };

describe("mail configuration", () => {
  it("requires a provider", () => {
    expect(() => loadConfig(database)).toThrow();
  });

  it("requires a sender and region for SES", () => {
    expect(() => loadConfig({ ...database, MAILER: "ses", AWS_REGION: "ap-south-1" })).toThrow();
    expect(() => loadConfig({ ...database, MAILER: "ses", MAIL_FROM: "hello@example.com" })).toThrow();
    expect(loadConfig({ ...database, MAILER: "ses", MAIL_FROM: "hello@example.com", AWS_REGION: "ap-south-1" }).MAILER).toBe("ses");
  });

  it("requires a sender and URL for Mailpit", () => {
    expect(() => loadConfig({ ...database, MAILER: "mailpit", MAILPIT_URL: "http://localhost:8025" })).toThrow();
    expect(() => loadConfig({ ...database, MAILER: "mailpit", MAIL_FROM: "hello@example.com" })).toThrow();
    expect(loadConfig({ ...database, MAILER: "mailpit", MAIL_FROM: "hello@example.com", MAILPIT_URL: "http://localhost:8025" }).MAILER).toBe("mailpit");
  });
});
