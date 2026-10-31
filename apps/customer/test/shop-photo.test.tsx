import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = value; }];
  },
}));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Image: "Image", Pressable: "Pressable", ScrollView: "ScrollView", SectionList: "SectionList", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("expo-router", () => ({ router: {}, useFocusEffect: vi.fn(), useLocalSearchParams: vi.fn(), useNavigation: vi.fn() }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button" }));
vi.mock("../src/api", () => ({ api: {} }));
vi.mock("../src/components/icons", () => ({ ImageIcon: "ImageIcon" }));
vi.mock("../src/components/stepper", () => ({ Stepper: "Stepper" }));
vi.mock("../src/components/top-bar", () => ({ TopBar: "TopBar" }));
vi.mock("../src/lib/use-cart", () => ({ useCart: vi.fn(), usePack: vi.fn() }));
import { ProductPhoto } from "../src/app/shop/[id]";

type Element = { type: unknown; props: Record<string, unknown> };
function render(uri: string | null) { mock.cursor = 0; return ProductPhoto({ uri }) as Element; }
const placeholder = (element: Element) => element.type === "View" && (element.props.children as Element).type === "ImageIcon";

describe("C05 product photo (#378)", () => {
  beforeEach(() => { mock.hooks = []; });

  it("shows the 256 px photo from the shop page", () => {
    const photo = render("https://images.ygo.example/p/256.webp");
    expect(photo.type).toBe("Image");
    expect(photo.props.source).toEqual({ uri: "https://images.ygo.example/p/256.webp" });
  });

  it("shows the placeholder when the product has no photo address", () => {
    expect(placeholder(render(null))).toBe(true);
  });

  it("falls back to the placeholder when the photo fails to load", () => {
    (render("https://images.ygo.example/p/256.webp").props.onError as () => void)();
    expect(placeholder(render("https://images.ygo.example/p/256.webp"))).toBe(true);
  });
});
