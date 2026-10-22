import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const database = {
  DATABASE_URL: "postgres://ygo:ygo@localhost:5432/ygo",
  AUTH_TOKEN_SECRET: "01234567890123456789012345678901",
};

describe("mail configuration", () => {
  it("requires a secret of at least 32 bytes", () => {
    expect(() => loadConfig({ ...database, AUTH_TOKEN_SECRET: "short" })).toThrow();
    expect(loadConfig({ ...database, MAILER: "mailpit", MAIL_FROM: "hello@example.com", MAILPIT_URL: "http://localhost:8025" }).AUTH_TOKEN_SECRET).toBe(database.AUTH_TOKEN_SECRET);
  });

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

describe("product image configuration", () => {
  const database = { DATABASE_URL: "postgres://ygo:ygo@localhost:5432/ygo", AUTH_TOKEN_SECRET: "a-secret-that-is-long-enough-for-tests" };
  const mailpit = { MAILER: "mailpit", MAIL_FROM: "hello@example.com", MAILPIT_URL: "http://localhost:8025" };

  it("requires the bucket and a CloudFront or local image URL base together", () => {
    expect(() => loadConfig({ ...database, ...mailpit, PRODUCT_IMAGE_BUCKET: "ygo-images" })).toThrow();
    expect(() => loadConfig({ ...database, ...mailpit, PRODUCT_IMAGE_CLOUDFRONT_DOMAIN: "images.example.com" })).toThrow();
    expect(loadConfig({
      ...database,
      ...mailpit,
      PRODUCT_IMAGE_BUCKET: "ygo-images",
      PRODUCT_IMAGE_CLOUDFRONT_DOMAIN: "images.example.com",
    })).toMatchObject({ S3_REGION: "ap-south-1" });
    expect(loadConfig({
      ...database,
      ...mailpit,
      PRODUCT_IMAGE_BUCKET: "ygo-images",
      PRODUCT_IMAGE_LOCAL_BASE_URL: "http://127.0.0.1:8333/ygo-images",
      S3_ENDPOINT: "http://127.0.0.1:8333",
    })).toMatchObject({ S3_REGION: "ap-south-1" });
    expect(() => loadConfig({
      ...database,
      ...mailpit,
      PRODUCT_IMAGE_BUCKET: "ygo-images",
      PRODUCT_IMAGE_LOCAL_BASE_URL: "http://127.0.0.1:8333/ygo-images",
    })).toThrow();
    expect(() => loadConfig({
      ...database,
      ...mailpit,
      PRODUCT_IMAGE_BUCKET: "ygo-images",
      PRODUCT_IMAGE_LOCAL_BASE_URL: "http://127.0.0.1:8333/ygo-images",
      PRODUCT_IMAGE_CLOUDFRONT_DOMAIN: "images.example.com",
      S3_ENDPOINT: "http://127.0.0.1:8333",
    })).toThrow();
  });
});
