import { Button, SupportEmail, Text, useSession } from "@ygo/mobile";
import { Link, usePathname } from "expo-router";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { AppState, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, session, supportEmail } from "../api";
import { strings } from "../strings";
import { SignOut } from "./sign-out";

/** Only cached Stock is reachable when launch identity came from the offline lease. */
export function StockAccess({ children }: { children: ReactNode }) {
  const state = useSession(session), view = useSyncExternalStore(access.subscribe, access.get);
  const pathname = usePathname(), insets = useSafeAreaInsets();

  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(true);
  const id = "account" in state ? state.account.id : undefined;
  async function verify() {
    const identity = session.get();
    if (!("account" in identity)) return;
    setChecking(true); setFailed(false);
    try { await access.verify(identity.account); } catch { setFailed(true); }
    finally { setChecking(false); }
  }
  useEffect(() => {
    void verify();
    const listener = AppState.addEventListener("change", (state) => { if (state === "active") void verify(); });
    return () => listener.remove();
  }, [id]);
  // Check the lease again while foregrounded so a screen cannot stay open past its deadline.
  useEffect(() => {
    if ((view.mode !== "offline" && view.mode !== "online") || !view.expiresAt) return;
    const watchClock = setInterval(() => access.expire(), 1000);
    const timer = setTimeout(() => access.expire(), Math.max(0, view.expiresAt - Date.now()));
    return () => { clearTimeout(timer); clearInterval(watchClock); };
  }, [view]);
  if (!checking && !failed && view.mode === "online" && view.accountId === id) return children;
  if (view.mode === "offline" && pathname === "/stock" && id && view.shopId && access.allowed(id, view.shopId)) return children;
  const words = strings.offlineAccess;
  return <ScrollView className="flex-1 bg-bg" contentContainerClassName="grow justify-center gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }}>
    <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
    <Text className="text-body text-pending">{view.mode === "signing-out" ? strings.offlineAccess.signingOut : failed ? strings.stock.storageFailed : view.mode === "expired" ? words.expired : view.mode === "erasing" ? words.erasing : view.mode === "ended" ? words.ended : words.body}</Text>
    {!checking && view.mode === "offline" && <Link href="/stock" className="py-3 text-body text-primary">{strings.stock.title}</Link>}
    <Button label={view.mode === "erasing" ? words.cleanup : words.retry} busy={checking || view.mode === "signing-out"} variant="secondary" onPress={() => { if (view.mode === "erasing") void access.cleanup(); else void verify(); }} />
    <SignOut disabled={view.mode === "erasing" || view.mode === "signing-out" || checking} />
    <SupportEmail address={supportEmail} className="text-secondary" />
  </ScrollView>;
}
