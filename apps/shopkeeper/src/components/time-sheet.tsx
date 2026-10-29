import { Button, Text } from "@ygo/mobile";
import { FlatList, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const ROW = 48;

/**
 * A list of times in a bottom sheet, opened on the current choice: the
 * opening hours' half hours (#371) and the switch's "Open until" (#380).
 */
export function TimeSheet({ title, times, selected, label, cancel, onPick, onCancel }: {
  title: string;
  times: readonly number[];
  selected?: number;
  label: (time: number) => string;
  cancel: string;
  onPick: (time: number) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-scrim">
        <View accessibilityViewIsModal className="max-h-[70%] gap-2 rounded-t-sheet bg-raised px-4 pt-4" style={{ paddingBottom: insets.bottom + 12 }}>
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{title}</Text>
          <FlatList
            data={times}
            keyExtractor={String}
            initialScrollIndex={selected === undefined ? 0 : Math.max(0, times.indexOf(selected) - 2)}
            getItemLayout={(_, index) => ({ length: ROW, offset: ROW * index, index })}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: item === selected }}
                onPress={() => onPick(item)}
                className={`h-12 justify-center rounded-input px-3 ${item === selected ? "bg-primary-subtle" : ""}`}
              >
                <Text className={`text-body tabular-nums ${item === selected ? "font-semibold text-on-primary-subtle" : "text-text"}`}>{label(item)}</Text>
              </Pressable>
            )}
          />
          <Button label={cancel} onPress={onCancel} variant="text" />
        </View>
      </View>
    </Modal>
  );
}
