import { describe, expect, it, vi } from "vitest";

const cssInterop = vi.hoisted(() => vi.fn());
vi.mock("nativewind", () => ({ cssInterop }));

const { colourIcons } = await import("../src/icons");

describe("colourIcons", () => {
  it("gives each icon its colour from the text class", () => {
    const Minus = () => null;
    const Plus = () => null;
    colourIcons(Minus, Plus);
    const colour = { className: { target: "style", nativeStyleToProp: { color: true } } };
    expect(cssInterop.mock.calls).toEqual([
      [Minus, colour],
      [Plus, colour],
    ]);
  });
});
