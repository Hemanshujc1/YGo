// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// React Native's views stand in as DOM elements, so ProductPhoto renders with real React state.
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => null, Pressable: () => null, ScrollView: () => null, SectionList: () => null,
    Image: ({ source, onError }: { source: { uri: string }; onError: () => void }) => createElement("img", { src: source.uri, onError }),
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/components/icons", async () => {
  const { createElement } = await import("react");
  return { ImageIcon: () => createElement("svg", { "data-icon": "image" }) };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("expo-router", () => ({ router: {}, useFocusEffect: vi.fn(), useLocalSearchParams: vi.fn(), useNavigation: vi.fn() }));
vi.mock("@ygo/mobile", () => ({ Text: () => null, Button: () => null }));
vi.mock("../src/api", () => ({ api: {} }));
vi.mock("../src/components/stepper", () => ({ Stepper: () => null }));
vi.mock("../src/components/top-bar", () => ({ TopBar: () => null }));
vi.mock("../src/lib/use-cart", () => ({ useCart: vi.fn(), usePack: vi.fn() }));
import { ProductPhoto } from "../src/app/shop/[id]";

const photo = "https://images.ygo.example/p/256.webp";
const placeholder = (container: HTMLElement) => container.querySelector("img") === null && container.querySelector("[data-icon=image]") !== null;

describe("C05 product photo (#378)", () => {
  afterEach(cleanup);

  it("shows the 256 px photo from the shop page", () => {
    const { container } = render(<ProductPhoto uri={photo} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(photo);
    expect(placeholder(container)).toBe(false);
  });

  it("shows the placeholder when the product has no photo address", () => {
    expect(placeholder(render(<ProductPhoto uri={null} />).container)).toBe(true);
  });

  it("re-renders into the placeholder when the photo fails to load", () => {
    const { container } = render(<ProductPhoto uri={photo} />);
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    if (image) fireEvent.error(image);
    expect(placeholder(container)).toBe(true);
  });
});
