import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  get: vi.fn(), open: vi.fn(), importLegacy: vi.fn(), set: vi.fn(),
  application: vi.fn(), listings: vi.fn(),
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => [initial, mock.set],
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Text: "Text" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("../src/api", () => ({
  session: { get: mock.get }, api: { shopApplication: mock.application, shopListings: mock.listings },
}));
vi.mock("../src/lib/opening-stock-database", () => ({
  openOpeningStock: mock.open, legacyOpeningStock: {},
}));

import OpeningStockScreen from "../src/app/opening-stock";

describe("opening-stock account boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.application.mockResolvedValue({ ok: true, data: { application: { id: "shop-1" } } });
    mock.listings.mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it("does not import legacy work when the account changes while its database opens", async () => {
    mock.get.mockReturnValue({ status: "signed-in", account: { id: "account-1" } });
    mock.open.mockImplementation(async () => {
      mock.get.mockReturnValue({ status: "signed-in", account: { id: "account-2" } });
      return { importLegacy: mock.importLegacy };
    });
    OpeningStockScreen();
    await vi.waitFor(() => expect(mock.get).toHaveBeenCalledTimes(2));
    expect(mock.open).toHaveBeenCalledWith("account-1");
    expect(mock.importLegacy).not.toHaveBeenCalled();
    expect(mock.set).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "loaded" }));
  });
});
