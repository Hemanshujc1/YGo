import { createApiClient } from "@ygo/api-client";
import { Email } from "@ygo/contracts";
import { createSession, phoneTheme, sessionStore, showSignedOut, showUpdateRequired } from "@ygo/mobile";
import { offlineAccess } from "./lib/offline-access";
import { closeOpeningStock, offlineStorage } from "./lib/opening-stock-database";
import Constants from "expo-constants";

// A phone has no page origin to fall back on, so a missing URL is a setup
// mistake, not an unreachable server. See README.md.
const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
if (!baseUrl) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set");

// Where Help and a phone in use point (#155, Q7); never written in the code.
const supportEmailSetting = Email.safeParse(process.env.EXPO_PUBLIC_SUPPORT_EMAIL);
if (!supportEmailSetting.success) throw new Error("EXPO_PUBLIC_SUPPORT_EMAIL is not set to an email address");
export const supportEmail = supportEmailSetting.data;

// The version in app.json, sent with every request so the server can refuse
// one that is too old (Q-7).
const version = Constants.expoConfig?.version;
if (!version) throw new Error("app.json has no version");

// Any call refused as too old shows the update screen (#137). The refresh
// token lives in the phone's secure storage, and a session the server ends
// goes back to sign-in (#155).
export const api = createApiClient({
  baseUrl,
  app: { name: "shopkeeper", version },
  onUpdateRequired: showUpdateRequired,
  session: sessionStore,
  onSignedOut: showSignedOut,
});

export const access = offlineAccess(offlineStorage, () => api.syncAccess());
const liveSession = createSession({ ...api, async me() {
  try { return await api.me(); } catch (error) {
    if (!await sessionStore.get()) throw error;
    const account = await access.restore();
    if (!account) throw error;
    return { ok: true as const, data: account };
  }
} }, phoneTheme);

export const session = { ...liveSession, async signOut() {
  epoch++;
  access.pause();
  const before = liveSession.get();
  if ("account" in before) void closeOpeningStock(before.account.id).catch(() => undefined);
  return liveSession.signOut();
} };

let previousAccount: string | undefined;
let epoch = 0;
export const accountEpoch = () => epoch;
session.subscribe(() => {
  const state = session.get();
  const next = "account" in state ? state.account.id : undefined;
  if (state.status === "signed-out" || (next && previousAccount && next !== previousAccount)) {
    epoch++;
    if (previousAccount) void closeOpeningStock(previousAccount).catch(() => undefined);
    access.reset();
  }
  if (next || state.status === "signed-out") previousAccount = next;
});
