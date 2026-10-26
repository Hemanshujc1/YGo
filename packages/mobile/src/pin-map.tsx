import type { AddressPoint } from "@ygo/contracts";
import { cssInterop } from "nativewind";
import { type ReactNode, useRef } from "react";
import { View } from "react-native";
import MapView, { PROVIDER_GOOGLE } from "react-native-maps";

cssInterop(MapView, { className: "style" });

// Street level when the map opens (#242, Q6).
const streetLevel = { latitudeDelta: 0.004, longitudeDelta: 0.004 };

/** True when two points are the same spot, as the map reports it again with tiny rounding. */
export function samePoint(a: AddressPoint, b: AddressPoint): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6;
}

/**
 * Google's map on both phones (#307, Q5), moving under a pin fixed in the
 * middle (#242, Q6): the spot under the pin's point is the one chosen.
 * `onMoved` gets each new spot once the map stops; Android also reports the
 * opening spot, which is skipped. `locked` holds the map still and lets
 * touches pass through, for a preview or while a spot is being saved.
 * Each app passes its own Lucide `pin`, its bottom tip at the middle.
 */
export function PinMap({
  start,
  onMoved,
  locked = false,
  pin,
  className,
}: {
  start: AddressPoint;
  onMoved?: (point: AddressPoint) => void;
  locked?: boolean;
  pin: ReactNode;
  className?: string;
}) {
  const last = useRef(start);
  return (
    <View className={className} pointerEvents={locked ? "none" : "auto"}>
      <MapView
        className="flex-1"
        provider={PROVIDER_GOOGLE}
        initialRegion={{ ...start, ...streetLevel }}
        onRegionChangeComplete={({ latitude, longitude }) => {
          const point = { latitude, longitude };
          if (samePoint(last.current, point)) return;
          last.current = point;
          onMoved?.(point);
        }}
        scrollEnabled={!locked}
        zoomEnabled={!locked}
        rotateEnabled={!locked}
        pitchEnabled={!locked}
        toolbarEnabled={false}
      />
      <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
        {pin}
      </View>
    </View>
  );
}
