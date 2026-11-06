import { JoinShop, Text, useSession } from "@ygo/mobile";
import { Link, useRouter } from "expo-router";
import { Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, api, session } from "../api";
import { takeUpJoin } from "../lib/join-shop";
import { strings } from "../strings";

const words = strings.joinShop;

/** S21 Join a shop (#536), opened from Start. Once joined the phone refreshes its access and opens the Staff home. */
export default function JoinShopScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const state = useSession(session);
  if (state.status !== "signed-in") return null;
  const { account } = state;
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <Link href="/" replace asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <JoinShop
        words={words}
        join={api.joinShop}
        onJoined={async () => {
          if (!(await takeUpJoin(() => access.verify(account), api.shopApplication))) return words.refreshFailed;
          router.replace("/");
          return null;
        }}
        onDone={() => router.replace("/")}
      />
    </ScrollView>
  );
}
