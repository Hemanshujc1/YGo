import type { SessionStore } from "@ygo/api-client";
import { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";

/** Where the refresh token itself is kept. */
interface Secrets {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

/** A flag that a sign-out has begun clearing the token. It holds no secret. */
interface Marker {
  isSet(): boolean;
  set(): void;
  clear(): void;
}

/**
 * The refresh token's store, for `createApiClient`'s `session`.
 *
 * Clearing sets the marker first and drops it only once the token is gone.
 * While it is set the token is never handed out, so a clear that failed
 * (the app then opens signed out) can't sign anyone back in; each read tries
 * the clear again (#155, S3). A new sign-in saves over the old token and then
 * drops the marker.
 */
export function makeSessionStore(secrets: Secrets, marker: Marker): SessionStore {
  return {
    async get() {
      if (!marker.isSet()) return secrets.get();
      try {
        await secrets.delete();
        marker.clear();
      } catch {
        // Still there: it stays unusable, and the next read tries again.
      }
      return null;
    },
    async set(token) {
      await secrets.set(token);
      marker.clear();
    },
    async clear() {
      marker.set();
      await secrets.delete();
      marker.clear();
    },
  };
}

// iOS: this phone only, so the Keychain never syncs it to iCloud or restores
// it on another phone, and readable once the phone is first unlocked after a
// restart. Android: encrypted with a Keystore key that never leaves the phone,
// and the expo-secure-store plugin in each app.json leaves it out of backups
// and phone-to-phone transfer (#155, S1).
const options = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const key = "refreshToken";

// MMKV holds the marker only: never the token (#155).
const flags = createMMKV({ id: "session" });
const signingOut = "signingOut";

/** Pass to `createApiClient` as `session`. */
export const sessionStore = makeSessionStore(
  {
    get: () => getItemAsync(key, options),
    set: (token) => setItemAsync(key, token, options),
    delete: () => deleteItemAsync(key, options),
  },
  {
    isSet: () => flags.getBoolean(signingOut) === true,
    set: () => flags.set(signingOut, true),
    clear: () => void flags.remove(signingOut),
  },
);
