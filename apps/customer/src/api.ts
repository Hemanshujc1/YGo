import { createApiClient } from "@ygo/api-client";
import { createSession, sessionStore, showSignedOut, showUpdateRequired } from "@ygo/mobile";
import Constants from "expo-constants";

// A phone has no page origin to fall back on, so a missing URL is a setup
// mistake, not an unreachable server. See README.md.
const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
if (!baseUrl) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set");

// The version in app.json, sent with every request so the server can refuse
// one that is too old (Q-7).
const version = Constants.expoConfig?.version;
if (!version) throw new Error("app.json has no version");

// Any call refused as too old shows the update screen (#137). The refresh
// token lives in the phone's secure storage, and a session the server ends
// goes back to sign-in (#155).
export const api = createApiClient({
  baseUrl,
  app: { name: "customer", version },
  onUpdateRequired: showUpdateRequired,
  session: sessionStore,
  onSignedOut: showSignedOut,
});

export const session = createSession(api);
