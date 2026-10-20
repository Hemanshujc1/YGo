import { AppVersion } from "@ygo/contracts";
import { z } from "zod";

// Configuration is environment variables only (ADR-0008).
const BaseEnv = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
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
