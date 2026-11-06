import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("@ygo/mobile", () => ({ AppShell: "AppShell", SessionGate: "SessionGate", applySavedTheme: () => calls.order.push("theme") }));
vi.mock("expo-router", () => ({ Navigator: "Navigator", Slot: "Slot" }));
vi.mock("../src/api", () => ({ api: {}, session: {}, supportEmail: "help@example.com" }));
vi.mock("../src/components/stock-access", () => ({ StockAccess: "StockAccess" }));
vi.mock("../src/components/sign-out", () => ({ SignOut: "SignOut" }));
vi.mock("../src/components/shop-tabs", () => ({ ShopTabs: "ShopTabs" }));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("../src/global.css", () => ({}));
vi.mock("../src/lib/push", () => ({}));
vi.mock("../src/lib/background-notifications", () => ({}));
vi.mock("../src/lib/bill-pdf-files", () => ({ retryBillPdfClear: () => calls.order.push("unfinished clear"), removeOldBillPdfs: () => calls.order.push("old PDFs"), removeAllBillPdfs: vi.fn() }));

it("finishes an unfinished sign-out clear, then deletes bill PDFs over an hour old, when the app starts (#488)", async () => {
  await import("../src/app/_layout");
  expect(calls.order).toEqual(["theme", "unfinished clear", "old PDFs"]);
});
