import { shopkeeperAppUrl, SwitchApp, Text } from "@ygo/mobile";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { api } from "../api";
import { strings } from "../strings";

const words = strings.account.shop;

/**
 * The shop link on C23 (#536, #551, ACC-4): "Join a shop" opens S21 when the account has no shop link, and an account
 * linked to a shop gets "Switch to shop", which opens the Shopkeeper app. Nothing shows until the server has answered or when it cannot be reached; the link is
 * only a convenience, since the Owner's code can still be typed at S21 from a later visit.
 */
export function ShopLink() {
  const [link, setLink] = useState<{ shopName: string | null } | null | undefined>(undefined);
  // On every focus, so coming back from S21 after joining shows the shop at once.
  useFocusEffect(useCallback(() => {
    let live = true;
    void api.syncAccess().then((answer) => { if (live && answer.ok) setLink(answer.data.shopId ? { shopName: answer.data.shopName } : null); }).catch(() => undefined);
    return () => { live = false; };
  }, []));
  if (link === undefined) return null;
  if (link) return <SwitchApp title={words.switchToShop} body={words.linkedBody(link.shopName)} url={shopkeeperAppUrl} notInstalled={words.notInstalled} />;
  return (
    <View className="overflow-hidden rounded-card border border-border bg-surface">
      <Pressable accessibilityRole="button" accessibilityLabel={words.join} onPress={() => router.push("/join-shop")} className="min-h-14 justify-center gap-1 px-4 py-3 active:bg-primary-subtle">
        <Text className="text-body font-semibold text-primary">{words.join}</Text>
        <Text className="text-secondary text-muted">{words.joinBody}</Text>
      </Pressable>
    </View>
  );
}
