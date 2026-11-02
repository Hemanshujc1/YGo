import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("@ygo/mobile", () => ({ AppShell: "AppShell", SessionGate: "SessionGate", applySavedTheme: () => calls.order.push("theme") }));
vi.mock("expo-router", () => ({ Navigator: "Navigator", Slot: "Slot" }));
vi.mock("../src/api", () => ({ api: {}, session: {}, supportEmail: "help@example.com" }));
vi.mock("../src/components/stock-access", () => ({ StockAccess: "StockAccess" }));
vi.mock("../src/components/sign-out", () => ({ SignOut: "SignOut" }));
vi.mock("../src/global.css", () => ({}));
vi.mock("../src/lib/bill-pdf-files", () => ({ removeOldBillPdfs: () => calls.order.push("old PDFs"), removeAllBillPdfs: vi.fn() }));

it("deletes bill PDFs over an hour old when the app starts, before any screen can share (#488)", async () => {
  await import("../src/app/_layout");
  expect(calls.order).toEqual(["theme", "old PDFs"]);
});
