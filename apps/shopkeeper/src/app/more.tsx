import { Text, ThemePicker } from "@ygo/mobile";
import { Link } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { session } from "../api";
import { SignOut } from "../components/sign-out";
import { SyncStatus } from "../components/sync-status";
import { useAccountRole } from "../lib/account-role";
import { strings } from "../strings";

const words = strings.more;
// Owner-only, and only they get the links: the server refuses anyone else (#550, specs S36).
const ownerLinks = [
  { href: "/staff", label: strings.staff.open },
  { href: "/void-bill", label: strings.voids.open },
] as const;
const shopSettings = [
  { href: "/agreement", label: strings.agreement.open },
  { href: "/listings", label: strings.shopSetup.listings },
  { href: "/hours", label: strings.hours.open },
  { href: "/opening-stock", label: strings.shopSetup.stock },
] as const;

function Row({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="button" className="rounded-button border border-primary px-4 py-3">
        <Text className="text-body font-semibold text-primary">{label}</Text>
      </Pressable>
    </Link>
  );
}

/** S36 More (#550): sync status, Theme, "Switch to Customer" (plain text until #551) and Sign out for everyone; Staff, Void a bill and Shop settings for the Owner only. */
export default function More() {
  const insets = useSafeAreaInsets();
  const owner = useAccountRole() === "owner";
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      <SyncStatus />
      {owner && ownerLinks.map((link) => <Row key={link.href} {...link} />)}
      {owner && (
        <View className="gap-3">
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.shopSettings}</Text>
          {shopSettings.map((link) => <Row key={link.href} {...link} />)}
        </View>
      )}
      <View className="mt-4 gap-8">
        <ThemePicker session={session} words={strings.theme} />
        <View className="gap-1">
          <Text className="text-label font-medium text-text">{words.switchToCustomer}</Text>
          <Text className="text-secondary text-muted">{words.switchBody}</Text>
        </View>
        <SignOut />
      </View>
    </ScrollView>
  );
}
