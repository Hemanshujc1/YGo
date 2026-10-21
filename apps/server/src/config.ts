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
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // The oldest app versions still served (Q-7); 0.0.0 refuses none.
  MIN_CUSTOMER_VERSION: AppVersion.default("0.0.0"),
  MIN_SHOPKEEPER_VERSION: AppVersion.default("0.0.0"),
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
]);

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return DatabaseUrl.parse(env.DATABASE_URL);
}
