import { z } from "zod";

/** The apps whose version the server checks (Q-7). Admin and the website are always current. */
export const AppName = z.enum(["customer", "shopkeeper"]);
export type AppName = z.infer<typeof AppName>;

/** The three-part app version, as in each app's Expo config (Q-7). */
export const AppVersion = z.string().regex(/^\d+\.\d+\.\d+$/);
export type AppVersion = z.infer<typeof AppVersion>;

/** Who is calling, sent with every mobile request so the server can refuse a version that is too old. */
export const AppIdentity = z.object({ name: AppName, version: AppVersion });
export type AppIdentity = z.infer<typeof AppIdentity>;

export const APP_NAME_HEADER = "x-ygo-app-name";
export const APP_VERSION_HEADER = "x-ygo-app-version";
