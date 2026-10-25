import type { ShopApplication } from "@ygo/contracts";
import { formatDate } from "@ygo/format";
import { Text } from "@ygo/mobile";
import { View } from "react-native";
import { type Step, steps } from "../lib/application-status";
import { strings } from "../strings";
import { Circle, CircleArrowRight, CircleCheck } from "./icons";

const words = strings.application.status;
const stepWords: Record<Step, { name: string; line: string; next?: string }> = words.steps;
const icons = { done: CircleCheck, current: CircleArrowRight, later: Circle };
const iconColour = { done: "text-success", current: "text-on-primary-subtle", later: "text-muted" };

/**
 * S18 Application status: the step tracker for a sent application (design
 * system: step tracker). Every step says who acts; the current one, on
 * `primary-subtle`, also says what happens next. Owner's answers on #292.
 */
export function ApplicationStatus({ application, refreshFailed }: { application: ShopApplication; refreshFailed: string | null }) {
  const shop = [application.shopName, application.areaName].filter(Boolean).join(" · ");
  return (
    <View className="gap-4">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">
          {words.title}
        </Text>
        {shop && <Text className="text-body text-muted">{shop}</Text>}
      </View>
      {refreshFailed && (
        <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
          {refreshFailed}
        </Text>
      )}
      <View className="gap-1">
        {steps(application.state).map(({ step, mark }) => {
          const current = mark === "current";
          const { name, line, next } = stepWords[step];
          const shownNext = current ? next : null;
          const sentOn = step === "submitted" && application.submittedAt ? words.sentOn(formatDate(application.submittedAt)) : null;
          const lineClass = `text-secondary ${current ? "text-on-primary-subtle" : "text-muted"}`;
          const Icon = icons[mark];
          return (
            <View
              key={step}
              accessible
              accessibilityLabel={[`${name}, ${words.marks[mark]}.`, line, sentOn, shownNext].filter(Boolean).join(" ")}
              className={`flex-row gap-3 rounded-card p-3 ${current ? "bg-primary-subtle" : ""}`}
            >
              <Icon size={24} className={iconColour[mark]} />
              <View className="flex-1 gap-1">
                <Text className={`text-body font-semibold ${current ? "text-on-primary-subtle" : mark === "later" ? "text-muted" : "text-text"}`}>
                  {name}
                </Text>
                <Text className={lineClass}>{line}</Text>
                {sentOn && <Text className={lineClass}>{sentOn}</Text>}
                {shownNext && <Text className="text-secondary font-semibold text-on-primary-subtle">{shownNext}</Text>}
              </View>
            </View>
          );
        })}
      </View>
      <Text className="text-secondary text-muted">{words.support}</Text>
    </View>
  );
}
