import type { AddressPoint } from "@ygo/contracts";
import { Button, Text } from "@ygo/mobile";
import { PinMap } from "@ygo/mobile/pin-map";
import { useRef } from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { strings } from "../strings";
import { ChevronLeft, MapPin } from "./icons";

const words = strings.application.form.map;

/**
 * S17's full-screen map behind "Move the pin" and "Set on map" (#307, Q2):
 * the map moves under the pin, and "Use this spot" hands back the spot
 * under it. Back, or Android's back, keeps the location as it was.
 */
export function MapPicker({ start, onUse, onBack }: { start: AddressPoint; onUse: (point: AddressPoint) => void; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  // The spot under the pin; the map opens on `start`.
  const spot = useRef(start);
  return (
    <Modal visible animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onBack}>
      <View className="flex-1 bg-bg" style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 16 }}>
        <View className="min-h-14 flex-row items-center gap-1 p-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={words.back}
            onPress={onBack}
            className="size-12 items-center justify-center rounded-full active:bg-primary-subtle"
          >
            <ChevronLeft className="text-text" />
          </Pressable>
          <Text accessibilityRole="header" className="flex-1 px-1 text-headline font-semibold text-text">
            {words.title}
          </Text>
        </View>
        <PinMap className="flex-1" start={start} onMoved={(point) => (spot.current = point)} pin={<MapPin size={40} className="mb-10 text-primary" />} />
        <View className="gap-4 px-4 pt-4">
          <Text className="text-body text-muted">{words.hint}</Text>
          <Button label={words.use} onPress={() => onUse(spot.current)} />
        </View>
      </View>
    </Modal>
  );
}
