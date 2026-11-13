import { Button, Text } from "@ygo/mobile";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../api";
import { Star } from "../../../components/icons";
import { StarRating } from "../../../components/star-rating";
import { TopBar } from "../../../components/top-bar";
import { useOrder } from "../../../lib/use-order";
import { strings } from "../../../strings";

// C20 Rate screen (TRU-1, #82): 1 to 5 stars, rate and rated states. Complaints left to #87.

const words = strings.rating;

export default function RateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { order, view } = useOrder(id);
  const [selectedStars, setSelectedStars] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedRating, setSubmittedRating] = useState<number | null>(null);

  const shown = view.order;
  const isFinished = shown?.status === "delivered" || shown?.status === "picked_up";
  const rating = submittedRating ?? shown?.rating ?? null;
  const isRated = rating !== null;

  const submit = async () => {
    if (!id || selectedStars === 0 || submitting || !isFinished) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.rateOrder(id, { stars: selectedStars });
      if (res.ok) {
        setSubmittedRating(selectedStars);
        void order.refresh();
      } else if (res.code === "RATING_ALREADY_GIVEN") {
        await order.refresh();
        const savedRating = (order.get ? order.get().order?.rating : null) ?? view.order?.rating ?? shown?.rating ?? null;
        if (savedRating !== null) {
          setSelectedStars(savedRating);
          setSubmittedRating(savedRating);
        } else {
          setError(strings.errors.RATING_ALREADY_GIVEN);
        }
      } else {
        setError(words.failed);
      }
    } catch {
      setError(words.failed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={words.title} />
      <ScrollView
        contentContainerClassName="gap-6 p-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        {view.status === "loading" && !shown ? (
          <View className="items-center py-12">
            <ActivityIndicator />
          </View>
        ) : view.status === "failed" && !shown ? (
          <View className="items-start gap-2">
            <Text className="text-secondary text-danger">{view.message ?? words.failed}</Text>
            <Button label={strings.order.retry} onPress={() => void order.retry()} variant="text" />
          </View>
        ) : isRated ? (
          <View className="gap-6 items-center py-8">
            <StarRating rating={rating} size={32} />
            <View className="items-center gap-2">
              <Text className="text-center text-title font-bold text-text">{words.ratedTitle}</Text>
              <Text className="text-center text-body text-muted">{words.alreadyRated(rating)}</Text>
              <Text className="text-center text-secondary text-muted">{words.ratedBody}</Text>
            </View>
            <View className="w-full pt-4">
              <Button label={words.done} onPress={() => router.back()} />
            </View>
          </View>
        ) : shown && !isFinished ? (
          <View className="gap-6 items-center py-8">
            <Text className="text-center text-body text-muted">{words.notEligible}</Text>
            <View className="w-full pt-4">
              <Button label={words.done} onPress={() => router.back()} />
            </View>
          </View>
        ) : shown ? (
          <View className="gap-6 py-4">
            <Text className="text-headline font-semibold text-text">
              {words.prompt(shown.shop.name)}
            </Text>
            <View className="flex-row items-center justify-center gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable
                  key={star}
                  accessibilityRole="button"
                  accessibilityLabel={words.starAriaLabel(star)}
                  accessibilityState={{ selected: star === selectedStars }}
                  onPress={() => setSelectedStars(star)}
                  className="h-[52px] w-[52px] items-center justify-center rounded-full active:bg-primary-subtle"
                >
                  <Star
                    size={32}
                    className={star <= selectedStars ? "text-accent" : "text-border"}
                    fill={star <= selectedStars ? "currentColor" : "transparent"}
                  />
                </Pressable>
              ))}
            </View>
            {error && (
              <Text accessibilityLiveRegion="polite" className="text-center text-secondary text-danger">
                {error}
              </Text>
            )}
            <View className="gap-3 pt-4">
              <Button
                label={submitting ? words.submitting : words.submit}
                disabled={selectedStars === 0 || submitting}
                busy={submitting}
                onPress={() => void submit()}
              />
              <Button
                label={words.skip}
                variant="secondary"
                disabled={submitting}
                onPress={() => router.back()}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
