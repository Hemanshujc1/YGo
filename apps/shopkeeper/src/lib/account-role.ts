import { useEffect, useSyncExternalStore } from "react";
import { access, session } from "../api";

/**
 * The account's role in its shop, for hiding what only the Owner does (BIL-6, #494). It only decides what the phone shows;
 * the server still answers FORBIDDEN to anyone else. Null while unknown: this asks the server once, as Stock's gate does,
 * since no other path on Home or S37 has checked access yet. A known role is refreshed by the sync pass.
 */
export function useAccountRole(check = true) {
  useSyncExternalStore(access.subscribe, access.get);
  const role = access.role();
  useEffect(() => {
    const identity = session.get();
    if (check && role === null && "account" in identity) void access.verify(identity.account).catch(() => undefined);
  }, [check, role]);
  return role;
}
