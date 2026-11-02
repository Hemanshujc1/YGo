import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Linking: {}, Pressable: "Pressable", Text: "Text" }));

const { Button } = await import("../src/sign-in-parts");

type Node = { type: unknown; props: Record<string, unknown> };
const elements = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
};
function render(props: Partial<Parameters<typeof Button>[0]>) {
  const all = elements(Button({ label: "Void bill", onPress: () => undefined, ...props }));
  const box = all.find((node) => node.type === "Pressable")?.props;
  const label = all.find((node) => node.type === "Text" && node.props.children === "Void bill")?.props;
  const spinner = all.find((node) => node.type === "ActivityIndicator")?.props;
  return { box: String(box?.className), disabled: box?.disabled, label: String(label?.className), spinner: spinner && String(spinner.className) };
}

describe("Button (#492)", () => {
  it("keeps the primary, secondary and text buttons as they were", () => {
    expect(render({})).toMatchObject({ box: expect.stringContaining("bg-primary active:bg-primary-pressed"), label: expect.stringContaining("text-on-primary") });
    expect(render({ variant: "secondary" })).toMatchObject({ box: expect.stringContaining("border-border-strong bg-surface"), label: expect.stringContaining("text-primary") });
    expect(render({ variant: "text" })).toMatchObject({ box: expect.stringContaining("min-h-12"), label: expect.stringContaining("text-primary") });
    expect(render({ busy: true }).spinner).toBe("text-on-primary");
    expect(render({ variant: "secondary", busy: true }).spinner).toBe("text-primary");
  });

  it("draws the destructive button red with on-danger text and spinner", () => {
    const red = render({ variant: "destructive" });
    expect(red.box).toContain("h-[52px] bg-danger");
    expect(red.label).toContain("text-on-danger");
    expect(render({ variant: "destructive", busy: true })).toMatchObject({ box: expect.stringContaining("bg-danger"), disabled: true, spinner: "text-on-danger" });
  });

  it("greys every filled button the same way when it is off", () => {
    for (const variant of ["primary", "secondary", "destructive"] as const) {
      expect(render({ variant, disabled: true })).toMatchObject({ box: expect.stringContaining("bg-disabled-bg"), disabled: true, label: expect.stringContaining("text-disabled-text") });
    }
  });
});
