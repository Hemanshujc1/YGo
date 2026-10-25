import type { ShopApplication } from "@ygo/contracts";
import { Button, Text, ThemePicker } from "@ygo/mobile";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { ApplicationForm } from "../components/application-form";
import { ApplicationStatus } from "../components/application-status";
import { SignOut } from "../components/sign-out";
import { strings } from "../strings";

const words = strings.application;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; application: ShopApplication | null };

/**
 * The signed-in home until shops go Live (#46) and staff join shops (#58):
 * Start with no application, S17 for a Draft, and S18 once sent, refreshed by
 * pulling down. Owner's answers on #40 (Q12, Q13), #276 (Q7) and #292 (Q5).
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
    if (answer?.ok) return setLoad({ kind: "loaded", application: answer.data.application });
    const message = answer ? strings.errors[answer.code] : refresh ? words.status.refreshFailed : words.loadFailed;
    if (refresh) setRefreshFailed(message);
    else setLoad({ kind: "failed", message });
  }

  useEffect(() => {
    void fetchApplication();
  }, []);

  async function start() {
    if (working.current) return;
    working.current = true;
    setStarting(true);
    setStartFailed(null);
    const answer = await api.startShopApplication().catch(() => null);
    working.current = false;
    setStarting(false);
    if (answer?.ok) return setLoad({ kind: "loaded", application: answer.data });
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

  const { application } = load;
  if (application?.state === "draft") {
    return (
      <ApplicationForm application={application} onSent={(sent) => (sent ? setLoad({ kind: "loaded", application: sent }) : void fetchApplication())} />
    );
  }

  if (application) {
    return (
      <Plain refreshing={refreshing} onRefresh={() => void fetchApplication(true)}>
        <ApplicationStatus application={application} refreshFailed={refreshFailed} />
      </Plain>
    );
  }

  return (
    <Plain>
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

/** A short screen with the theme picker and Sign out under it; scrolls so Sign out stays reachable at the largest font sizes. */
function Plain({ children, refreshing = false, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
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
      <View className="mt-8 gap-8">
        <ThemePicker session={session} words={strings.theme} />
        <SignOut />
      </View>
    </ScrollView>
  );
}
