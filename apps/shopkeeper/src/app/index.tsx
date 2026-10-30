import type { LiveCheck, ShopApplication } from "@ygo/contracts";
import { Button, Text, ThemePicker } from "@ygo/mobile";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Link, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { ApplicationForm } from "../components/application-form";
import { ApplicationStatus } from "../components/application-status";
import { OpenSwitch } from "../components/open-switch";
import { SignOut } from "../components/sign-out";
import { waiting } from "../lib/application-status";
import { strings } from "../strings";

const words = strings.application;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; application: ShopApplication | null; liveCheck: LiveCheck | null };

/**
 * The signed-in home until a Live shop gets its own home and staff join shops (#58):
 * Start with no application, S17 for a Draft, and S18 once sent, refreshed by
 * pulling down. From Approved on, S14 lists what still keeps the shop from
 * Live and keeps the setup buttons (#363). Owner's answers on #40 (Q12, Q13),
 * #276 (Q7), #292 (Q5) and #46 (11).
 */
export default function Home() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState<string | null>(null);
  // Set before React re-renders, so a second tap never starts twice.
  const working = useRef(false);

  // The first load shows a spinner in place of the screen; a refresh keeps
  // the steps on screen while it looks, and after a failed look (#292, Q5).
  async function fetchApplication(refresh = false) {
    if (refresh) {
      setRefreshing(true);
      setRefreshFailed(null);
    } else setLoad({ kind: "loading" });
    const answer = await api.shopApplication().catch(() => null);
    setRefreshing(false);
    if (answer?.ok) return setLoad({ kind: "loaded", ...answer.data });
    const message = answer ? strings.errors[answer.code] : refresh ? words.status.refreshFailed : words.loadFailed;
    if (refresh) setRefreshFailed(message);
    else setLoad({ kind: "failed", message });
  }

  // Loads on the first visit; coming back, say from accepting the agreement, refreshes in place.
  const seen = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void fetchApplication(seen.current);
      seen.current = true;
    }, []),
  );

  async function start() {
    if (working.current) return;
    working.current = true;
    setStarting(true);
    setStartFailed(null);
    const answer = await api.startShopApplication().catch(() => null);
    working.current = false;
    setStarting(false);
    if (answer?.ok) return setLoad({ kind: "loaded", application: answer.data, liveCheck: null });
    // Started on another phone: open that one.
    if (answer?.code === "SHOP_APPLICATION_EXISTS") return void fetchApplication();
    setStartFailed(answer ? strings.errors[answer.code] : words.start.offline);
  }

  if (load.kind === "loading") {
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <ActivityIndicator size="large" className="text-primary" />
      </View>
    );
  }

  if (load.kind === "failed") {
    return (
      <Plain>
        <Text accessibilityLiveRegion="polite" className="text-body text-text">
          {load.message}
        </Text>
        <Button label={words.retry} onPress={() => void fetchApplication()} variant="secondary" />
      </Plain>
    );
  }

  const { application, liveCheck } = load;
  if (application?.state === "draft") {
    return (
      <ApplicationForm application={application} onSent={(sent) => (sent ? setLoad({ kind: "loaded", application: sent, liveCheck: null }) : void fetchApplication())} />
    );
  }

  if (application) {
    return (
      <Plain stock={application.state === "live" || application.state === "suspended"} verifiedShopId={application.id} refreshing={refreshing} onRefresh={() => void fetchApplication(true)}>
        {application.state === "live" && <OpenSwitch />}
        {application.state === "suspended" && <Text className="text-body text-danger">{strings.stock.suspended}</Text>}
        <ApplicationStatus application={application} refreshFailed={refreshFailed} />
        {liveCheck && <Waiting check={liveCheck} />}
        {(application.state === "approved" || application.state === "live") && (
          <View className="gap-3">
            <Text accessibilityRole="header" className="text-title font-semibold text-text">{strings.shopSetup.title}</Text>
            <Link href="/agreement" asChild>
              <Pressable accessibilityRole="button" className="rounded-button bg-primary px-4 py-3">
                <Text className="text-body font-semibold text-on-primary">{strings.agreement.open}</Text>
              </Pressable>
            </Link>
            <Link href="/listings" asChild>
              <Pressable accessibilityRole="button" className="rounded-button bg-primary px-4 py-3">
                <Text className="text-body font-semibold text-on-primary">{strings.shopSetup.listings}</Text>
              </Pressable>
            </Link>
            <Link href="/hours" asChild>
              <Pressable accessibilityRole="button" className="rounded-button bg-primary px-4 py-3">
                <Text className="text-body font-semibold text-on-primary">{strings.hours.open}</Text>
              </Pressable>
            </Link>
            <Link href="/opening-stock" asChild>
              <Pressable accessibilityRole="button" className="rounded-button border border-primary px-4 py-3">
                <Text className="text-body font-semibold text-primary">{strings.shopSetup.stock}</Text>
              </Pressable>
            </Link>
          </View>
        )}
      </Plain>
    );
  }

  return (
    <Plain stock verifiedShopId={null}>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">
        {words.start.title}
      </Text>
      <Text className="text-body text-muted">{words.start.body}</Text>
      <Button label={words.start.button} onPress={() => void start()} busy={starting} />
      {startFailed && (
        <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
          {startFailed}
        </Text>
      )}
      <Text className="text-secondary text-muted">{words.start.staff}</Text>
    </Plain>
  );
}

/** S14's "Waiting for" list: YGo's steps as lines, the Owner's own steps as buttons (#363, #371). */
function Waiting({ check }: { check: LiveCheck }) {
  const words = strings.shopSetup.waiting;
  const items = waiting(check);
  if (!items.length) return <Text className="text-body text-success">{words.ready}</Text>;
  return (
    <View className="gap-3">
      <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.title}</Text>
      {items.map((item) => item.href ? (
        <Link key={item.blocker} href={item.href} asChild>
          <Pressable accessibilityRole="button" className="rounded-button bg-primary px-4 py-3">
            <Text className="text-body font-semibold text-on-primary">{item.line}</Text>
          </Pressable>
        </Link>
      ) : (
        <Text key={item.blocker} className="text-body text-pending">• {item.line}</Text>
      ))}
    </View>
  );
}

/** A short screen with the theme picker and Sign out under it; scrolls so Sign out stays reachable at the largest font sizes. */
function Plain({ children, refreshing = false, onRefresh, verifiedShopId, stock = false }: { stock?: boolean; verifiedShopId?: string | null; children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      // The offset keeps Android's spinner below the status bar, as the app draws edge to edge.
      refreshControl={onRefresh && <RefreshControl refreshing={refreshing} onRefresh={onRefresh} progressViewOffset={insets.top} />}
      className="flex-1 bg-bg"
      contentContainerClassName="grow justify-center gap-4 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }}
    >
      {children}
      {stock && <Link href="/stock" asChild>
        <Pressable accessibilityRole="button" className="rounded-button border border-primary px-4 py-3">
          <Text className="text-body font-semibold text-primary">{strings.stock.title}</Text>
        </Pressable>
      </Link>}
      <View className="mt-8 gap-8">
        <ThemePicker session={session} words={strings.theme} />
        <SignOut verifiedShopId={verifiedShopId} />
      </View>
    </ScrollView>
  );
}
