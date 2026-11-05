import { AppVersion, ORDER_ANSWER_SECONDS } from "@ygo/contracts";
import { z } from "zod";

// Configuration is environment variables only (ADR-0008).
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

// The two order timers of ORD-2 (#57): the shop's alarm rings again, then an unanswered order expires. The apps count
// down from ORDER_ANSWER_SECONDS (600) in @ygo/contracts, so changing the expiry needs a matching app update.
const OrderTimingShape = {
  ORDER_REALERT_SECONDS: z.coerce.number().int().positive().default(120),
  ORDER_EXPIRE_SECONDS: z.coerce.number().int().positive().default(ORDER_ANSWER_SECONDS),
};
const realertBeforeExpiry = (env: { ORDER_REALERT_SECONDS: number; ORDER_EXPIRE_SECONDS: number }) =>
  env.ORDER_REALERT_SECONDS < env.ORDER_EXPIRE_SECONDS;
const realertMessage = "ORDER_REALERT_SECONDS must be less than ORDER_EXPIRE_SECONDS";
const OrderTimingEnv = z.object(OrderTimingShape).refine(realertBeforeExpiry, { message: realertMessage });

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
  // How long after the server receives a counter bill the Owner may void it (BIL-6, #54).
  COUNTER_BILL_VOID_SECONDS: z.coerce.number().int().positive().default(86400),
  ...OrderTimingShape,
  DELIVERY_FAILURE_WAIT_SECONDS: z.coerce.number().int().positive().default(120),
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
  // Pushes go to Expo's push service with "expo"; "local" only logs them (#505).
  PUSH_SENDER: z.enum(["local", "expo"]).default("local"),
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
  if (!realertBeforeExpiry(env)) context.addIssue({ code: "custom", message: realertMessage });
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

/** The order timers alone, for the timed-job command, which reads no other setting. */
export function loadOrderTiming(env: NodeJS.ProcessEnv = process.env): { reRingSeconds: number; expireSeconds: number } {
  const timing = OrderTimingEnv.parse(env);
  return { reRingSeconds: timing.ORDER_REALERT_SECONDS, expireSeconds: timing.ORDER_EXPIRE_SECONDS };
}
