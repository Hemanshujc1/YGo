import type { SessionStore } from "@ygo/api-client";
import { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";
import { SessionNotSaved } from "./sign-in-flow";
import { showSignedOut } from "./signed-out";

/** Where the refresh token itself is kept. */
interface Secrets {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

/** Set while the saved token must not be used. It holds no secret. */
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
 * can't sign anyone back in; each read tries the clear again (#155, S3). A
 * failed clear also calls `cleared`, so the app goes to sign-in even when
 * the server ended the session. A token that can't be read counts as none.
 * A new sign-in saves over the old token and then drops the marker; if
 * either fails it rejects with `SessionNotSaved`. A marker
 * that can't be read counts as set, and one that can't be set still lets the
 * delete go ahead. The client queues every call here in order (#161), so a
 * sign-in and a sign-out never overlap.
 */
export function makeSessionStore(secrets: Secrets, marker: Marker, cleared: () => void): SessionStore {
  async function forget() {
    try {
      await secrets.delete();
      marker.clear();
    } catch {
      // Still there: it stays unusable, and the next read tries again.
    }
  }

  return {
    async get() {
      let blocked: boolean;
      try {
        blocked = marker.isSet();
      } catch {
        blocked = true;
      }
      if (blocked) {
        await forget();
        return null;
      }
      try {
        return await secrets.get();
      } catch {
        // Unreadable (a Keystore key the phone replaced, a damaged item): sign in again.
        await forget();
        return null;
      }
    },
    async set(token) {
      try {
        await secrets.set(token);
        marker.clear();
      } catch (err) {
        throw new SessionNotSaved(err);
      }
    },
    async clear() {
      try {
        marker.set();
      } catch {
        // Still delete: only a delete that also fails leaves the token usable.
      }
      try {
        await secrets.delete();
      } catch (err) {
        cleared();
        throw err;
      }
      try {
        marker.clear();
      } catch {
        // The token is gone; a marker left set only makes the next read delete nothing.
      }
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

// MMKV holds two flags, never the token (#155). The Keychain keeps an
// item after the app is deleted but MMKV doesn't, so a fresh install never
// picks up the token of whoever used the app before.
const flags = createMMKV({ id: "session" });
const signingOut = "signingOut";
const installed = "installed";

/** Pass to `createApiClient` as `session`. */
export const sessionStore = makeSessionStore(
  {
    get: () => getItemAsync(key, options),
    set: (token) => setItemAsync(key, token, options),
    delete: () => deleteItemAsync(key, options),
  },
  {
    isSet: () => flags.getBoolean(signingOut) === true || flags.getBoolean(installed) !== true,
    set: () => flags.set(signingOut, true),
    clear: () => {
      flags.set(installed, true);
      flags.remove(signingOut);
    },
  },
  showSignedOut,
);
