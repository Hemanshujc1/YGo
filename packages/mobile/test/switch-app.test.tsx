import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ openURL: vi.fn(), state: undefined as unknown }));

vi.mock("react-native", () => ({ Linking: { openURL: mock.openURL }, Pressable: "Pressable", View: "View", Text: "Text" }));
// One state cell, so the test can tap and then draw the component again with what the tap set.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => [mock.state ?? initial, (next: unknown) => { mock.state = next; }] };
});
const { SwitchApp } = await import("../src/switch-app");

type Node = { type: unknown; props: Record<string, unknown> };
const elements = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
};
const props = { title: "Switch to shop", body: "Sai General Stores", url: "ygo-shopkeeper://", notInstalled: "Install the YGo Shop app to switch" };
const draw = () => elements(SwitchApp(props));
const texts = () => draw().flatMap((node) => (typeof node.props.children === "string" ? [node.props.children] : []));
const tap = async () => {
  (draw().find((node) => node.type === "Pressable")?.props.onPress as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("SwitchApp row (#551, ACC-4)", () => {
  beforeEach(() => { mock.state = undefined; vi.clearAllMocks(); });

  it("shows the title and body, with no warning before a tap", () => {
    expect(texts()).toEqual(["Switch to shop", "Sai General Stores"]);
    expect(draw().find((node) => node.type === "Pressable")?.props.accessibilityLabel).toBe("Switch to shop");
  });

  it("opens the other app's link when tapped and shows no warning when it opens", async () => {
    mock.openURL.mockResolvedValue(true);
    await tap();
    expect(mock.openURL).toHaveBeenCalledExactlyOnceWith("ygo-shopkeeper://");
    expect(texts()).not.toContain(props.notInstalled);
  });

  it("shows the install message when the open fails, without throwing or touching the session", async () => {
    mock.openURL.mockRejectedValue(new Error("Unable to open URL: ygo-shopkeeper://"));
    await expect(tap()).resolves.toBeUndefined();
    expect(texts()).toContain(props.notInstalled);
  });

  it("clears the message when a later tap opens the app", async () => {
    mock.openURL.mockRejectedValueOnce(new Error("no app")).mockResolvedValueOnce(true);
    await tap();
    expect(texts()).toContain(props.notInstalled);
    await tap();
    expect(texts()).not.toContain(props.notInstalled);
  });
});
