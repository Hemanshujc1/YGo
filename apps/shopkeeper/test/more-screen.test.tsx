import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ role: "owner" as "owner" | "staff" | null }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", ThemePicker: "ThemePicker", SwitchApp: "SwitchApp", customerAppUrl: "ygo-customer://" }));
vi.mock("react-native", () => ({ Pressable: "Pressable", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ session: {} }));
vi.mock("../src/components/sign-out", () => ({ SignOut: "SignOut" }));
vi.mock("../src/components/sync-status", () => ({ SyncStatus: "SyncStatus" }));
vi.mock("../src/lib/account-role", () => ({ useAccountRole: () => mock.role }));
import More from "../src/app/more";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const shown = () => elements(More());
const links = () => shown().filter((node) => node.type === "Link").map((node) => node.props.href);
const texts = () => shown().flatMap(({ props: { children } }) => (typeof children === "string" ? [children] : []));

describe("S36 More (#550)", () => {
  beforeEach(() => { mock.role = "owner"; });

  it("gives everyone sync status, Theme, Sign out and the Switch to Customer row, just below Theme", () => {
    for (const role of ["owner", "staff", null] as const) {
      mock.role = role;
      const types = shown().map((node) => node.type);
      expect(types).toEqual(expect.arrayContaining(["SyncStatus", "ThemePicker", "SignOut"]));
      const order = shown().map((node) => node.type);
      expect(order.indexOf("SwitchApp")).toBe(order.indexOf("ThemePicker") + 1);
      const row = shown().find((node) => node.type === "SwitchApp");
      expect(row?.props).toMatchObject({ title: strings.more.switchToCustomer, url: "ygo-customer://", notInstalled: strings.more.notInstalled });
    }
  });

  it("gives the Owner Staff, Void a bill and the Shop settings screens", () => {
    expect(links()).toEqual(["/staff", "/void-bill", "/agreement", "/listings", "/hours", "/shop-discount", "/fulfilment", "/opening-stock"]);
    expect(texts()).toContain(strings.more.shopSettings);
  });

  it("hides every Owner-only entry from Staff and when the phone knows no role, and offers no Money or deletion", () => {
    for (const role of ["staff", null] as const) {
      mock.role = role;
      expect(links()).toEqual([]);
      expect(texts()).not.toContain(strings.more.shopSettings);
    }
    expect(texts().join(" ")).not.toMatch(/money|delete/i);
  });
});
