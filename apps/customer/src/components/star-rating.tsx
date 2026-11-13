import { View } from "react-native";
import { Star } from "./icons";

// 5-star display row for ratings (TRU-1, #82).
export function StarRating({ rating, size = 18 }: { rating: number | null; size?: number }) {
  const value = rating ?? 0;
  return (
    <View className="flex-row items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={size}
          className={star <= value ? "text-accent" : "text-border"}
          fill={star <= value ? "currentColor" : "transparent"}
        />
      ))}
    </View>
  );
}
