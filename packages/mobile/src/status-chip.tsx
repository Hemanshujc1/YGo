import { Bell, CircleArrowRight, CircleCheck, CircleX, Clock } from "lucide-react-native";
import { View } from "react-native";
import { colourIcons } from "./icons";
import { Text } from "./text";

colourIcons(Bell, CircleArrowRight, CircleCheck, CircleX, Clock);

/** Who has to act (design system section 6); each app maps the statuses to these for its own user. */
export type Treatment = "needsYou" | "waiting" | "inProgress" | "completed" | "ended";

/** The five looks of design system section 6. */
const looks: Record<Treatment, { box: string; text: string; icon: typeof Clock }> = {
  needsYou: { box: "bg-accent", text: "text-on-accent", icon: Bell },
  waiting: { box: "bg-info-subtle", text: "text-on-info-subtle", icon: Clock },
  inProgress: { box: "bg-primary-subtle", text: "text-on-primary-subtle", icon: CircleArrowRight },
  completed: { box: "bg-success-subtle", text: "text-on-success-subtle", icon: CircleCheck },
  ended: { box: "border border-border-strong", text: "text-text", icon: CircleX },
};

/** An order's status in the app's own word, with its treatment's look. */
export function StatusChip({ word, treatment }: { word: string; treatment: Treatment }) {
  const look = looks[treatment];
  const Icon = look.icon;
  return (
    <View className={`h-8 flex-row items-center gap-1.5 self-start rounded-full px-3 ${look.box}`}>
      <Icon size={16} className={look.text} />
      <Text className={`text-label font-medium ${look.text}`}>{word}</Text>
    </View>
  );
}
