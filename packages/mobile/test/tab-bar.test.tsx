import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View", Text: "Text" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }));

const { TabBar } = await import("../src/tab-bar");

type Node = { type: unknown; props: Record<string, any> };
const elements = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
};
const Icon = () => null;
const tabs = [{ key: "orders", label: "Orders", icon: Icon }, { key: "more", label: "More", icon: Icon }];

describe("TabBar (#550)", () => {
  it("draws one tab per item, marking only the active one selected", () => {
    const pressables = elements(TabBar({ tabs, active: "more", onSelect: () => undefined })).filter((node) => node.type === "Pressable");
    expect(pressables.map((node) => node.props.accessibilityLabel)).toEqual(["Orders", "More"]);
    expect(pressables.map((node) => node.props.accessibilityState.selected)).toEqual([false, true]);
    expect(pressables.every((node) => node.props.accessibilityRole === "tab")).toBe(true);
  });

  it("says which tab was tapped", () => {
    const onSelect = vi.fn();
    elements(TabBar({ tabs, active: "orders", onSelect })).filter((node) => node.type === "Pressable")[1]?.props.onPress();
    expect(onSelect).toHaveBeenCalledWith("more");
  });

  it("keeps clear of the bottom safe area and highlights no tab off a tab route", () => {
    const all = elements(TabBar({ tabs, active: null, onSelect: () => undefined }));
    expect(all.find((node) => node.type === "View")?.props.style).toEqual({ paddingBottom: 34 });
    expect(all.filter((node) => node.type === "Pressable").some((node) => node.props.accessibilityState.selected)).toBe(false);
  });
});
