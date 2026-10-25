import { Button, Text } from "@ygo/mobile";
import { Modal, View } from "react-native";

/** A yes-or-cancel question in the YGo design rather than the phone's own alert: Sign out and Send (#295, Q7). */
export function Confirm({
  visible,
  title,
  body,
  confirm,
  cancel,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal transparent visible={visible} animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View className="flex-1 justify-center bg-scrim px-4">
        <View accessibilityViewIsModal className="gap-4 rounded-dialog bg-raised p-4">
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">
            {title}
          </Text>
          <Text className="text-body text-text">{body}</Text>
          <View className="gap-2.5">
            <Button label={confirm} onPress={onConfirm} />
            <Button label={cancel} onPress={onCancel} variant="text" />
          </View>
        </View>
      </View>
    </Modal>
  );
}
