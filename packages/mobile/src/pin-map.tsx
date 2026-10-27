import type { AddressPoint } from "@ygo/contracts";
import { cssInterop } from "nativewind";
import { type ReactNode, type Ref, useImperativeHandle, useRef } from "react";
import { View } from "react-native";
import MapView, { PROVIDER_GOOGLE } from "react-native-maps";

cssInterop(MapView, { className: "style" });

// Street level when the map opens (#242, Q6).
const streetLevel = { latitudeDelta: 0.004, longitudeDelta: 0.004 };

/** True when two points are the same spot, as the map reports it again with tiny rounding. */
export function samePoint(a: AddressPoint, b: AddressPoint): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6;
}

/** Reads the spot under the pin right now, even while the map is still gliding after a swipe. */
export type PinMapHandle = { spot: () => Promise<AddressPoint> };

/**
 * The spot at the map's centre now. `last`, the spot where the map last
 * stopped, stands in if the map can't say; that spot can be out of date
 * while the map still glides, so it is only the fallback.
 */
export async function spotNow(map: { getCamera: () => Promise<{ center: AddressPoint }> } | null, last: AddressPoint): Promise<AddressPoint> {
  if (!map) return last;
  try {
    const { latitude, longitude } = (await map.getCamera()).center;
    return { latitude, longitude };
  } catch {
    return last;
  }
}

/**
 * Google's map on both phones (#307, Q5), moving under a pin fixed in the
 * middle (#242, Q6): the spot under the pin's point is the one chosen.
 * `onMoved` gets each new spot once the map stops; Android also reports the
 * opening spot, which is skipped. `onMoving` hears when the map starts moving
 * and when it stops, even where it began, so a screen can tell while the spot
 * under the pin is not known yet (#339). Both phones may report several starts
 * (a drag, then a fling) before one stop, always in order, so the newest
 * report says whether the map moves. `locked` holds the map still and lets
 * touches pass through, for a preview or while a spot is being saved.
 * Each app passes its own Lucide `pin`, its bottom tip at the middle.
 * `ref` reads the spot under the pin at the moment of a tap.
 */
export function PinMap({
  start,
  onMoved,
  onMoving,
  locked = false,
  pin,
  className,
  ref,
}: {
  ref?: Ref<PinMapHandle>;
  start: AddressPoint;
  onMoved?: (point: AddressPoint) => void;
  onMoving?: (moving: boolean) => void;
  locked?: boolean;
  pin: ReactNode;
  className?: string;
}) {
  const last = useRef(start);
  const map = useRef<MapView>(null);
  useImperativeHandle(ref, () => ({ spot: () => spotNow(map.current, last.current) }), []);
  return (
    <View className={className} pointerEvents={locked ? "none" : "auto"}>
      <MapView
        ref={map}
        className="flex-1"
        provider={PROVIDER_GOOGLE}
        initialRegion={{ ...start, ...streetLevel }}
        onRegionChangeStart={() => onMoving?.(true)}
        onRegionChangeComplete={({ latitude, longitude }) => {
          const point = { latitude, longitude };
          if (!samePoint(last.current, point)) {
            last.current = point;
            onMoved?.(point);
          }
          onMoving?.(false);
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
