import { JoinShop } from "@ygo/mobile";
import { router } from "expo-router";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { TopBar } from "../components/top-bar";
import { strings } from "../strings";

/** S21 Join a shop (#536), opened from C23. */
export default function JoinShopScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={strings.joinShop.title} />
      <ScrollView contentContainerClassName="px-4 pt-2" contentContainerStyle={{ paddingBottom: insets.bottom + 16 }} keyboardShouldPersistTaps="handled">
        <JoinShop words={strings.joinShop} join={api.joinShop} onJoined={async () => null} onDone={() => router.back()} />
      </ScrollView>
    </View>
  );
}
