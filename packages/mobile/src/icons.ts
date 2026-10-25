import { cssInterop } from "nativewind";

/** Lets each icon take its colour from a text class, such as `text-muted` (#296). */
export function colourIcons(...icons: Parameters<typeof cssInterop>[0][]) {
  for (const icon of icons) {
    cssInterop(icon, { className: { target: "style", nativeStyleToProp: { color: true } } });
  }
}
