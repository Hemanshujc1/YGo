import { Minus, Plus } from "lucide-react-native";
import { cssInterop } from "nativewind";

// An icon takes its colour from a text class, such as `text-muted`.
for (const icon of [Minus, Plus]) {
  cssInterop(icon, { className: { target: "style", nativeStyleToProp: { color: true } } });
}

export { Minus, Plus };
