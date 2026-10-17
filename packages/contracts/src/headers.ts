import { z } from "zod";
import { AppName, AppVersion } from "./fields";

/** The app identity used to enforce the server's per-app version floor (Q-7). */
export const AppIdentity = z.object({ name: AppName, version: AppVersion });
export type AppIdentity = z.infer<typeof AppIdentity>;
export const APP_NAME_HEADER = "x-ygo-app-name";
export const APP_VERSION_HEADER = "x-ygo-app-version";
