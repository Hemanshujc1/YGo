import { AppVersion } from "@ygo/contracts";
import { z } from "zod";

// Configuration is environment variables only (ADR-0008).
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

const BaseEnv = z.object({
  DATABASE_URL: DatabaseUrl,
  AUTH_TOKEN_SECRET: z.string().refine((secret) => Buffer.byteLength(secret, "utf8") >= 32, {
    message: "must be at least 32 bytes",
  }),
  ADMIN_COOKIE_DOMAIN: z.string().regex(/^\.?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i).optional(),
  GOOGLE_CLIENT_IDS: z.string().default(""),
  APPLE_CLIENT_IDS: z.string().default(""),
  SYNC_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(7 * 86400),
  SYNC_CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // The oldest app versions still served (Q-7); 0.0.0 refuses none.
  MIN_CUSTOMER_VERSION: AppVersion.default("0.0.0"),
  MIN_SHOPKEEPER_VERSION: AppVersion.default("0.0.0"),
  VISIT_PHOTO_BUCKET: z.string().min(3).optional(),
  PRODUCT_IMAGE_BUCKET: z.string().min(3).optional(),
  PRODUCT_IMAGE_CLOUDFRONT_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/i).optional(),
  PRODUCT_IMAGE_LOCAL_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  S3_REGION: z.string().min(1).default("ap-south-1"),
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  // C15's place search (#257); without it, or left empty, the search answers UNAVAILABLE.
  GOOGLE_PLACES_API_KEY: z.string().optional().transform((key) => key || undefined),
});

const Env = z.discriminatedUnion("MAILER", [
  BaseEnv.extend({
    MAILER: z.literal("ses"),
    MAIL_FROM: z.email(),
    AWS_REGION: z.string().min(1),
  }),
  BaseEnv.extend({
    MAILER: z.literal("mailpit"),
    MAIL_FROM: z.email(),
    MAILPIT_URL: z.url({ protocol: /^https?$/ }),
  }),
]).superRefine((env, context) => {
  if (env.VISIT_PHOTO_BUCKET && env.VISIT_PHOTO_BUCKET === env.PRODUCT_IMAGE_BUCKET) {
    context.addIssue({ code: "custom", message: "VISIT_PHOTO_BUCKET must be separate from public product images" });
  }
  const hasCloudFront = Boolean(env.PRODUCT_IMAGE_CLOUDFRONT_DOMAIN);
  const hasLocalBase = Boolean(env.PRODUCT_IMAGE_LOCAL_BASE_URL);
  if (Boolean(env.PRODUCT_IMAGE_BUCKET) !== (hasCloudFront || hasLocalBase)) {
    context.addIssue({
      code: "custom",
      message: "PRODUCT_IMAGE_BUCKET and an image URL base must be configured together",
    });
  }
  if (hasCloudFront && hasLocalBase) {
    context.addIssue({ code: "custom", message: "Choose either CloudFront or a local product image URL base" });
  }
  if (hasLocalBase && !env.S3_ENDPOINT) {
    context.addIssue({ code: "custom", message: "PRODUCT_IMAGE_LOCAL_BASE_URL requires S3_ENDPOINT" });
  }
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return DatabaseUrl.parse(env.DATABASE_URL);
}
