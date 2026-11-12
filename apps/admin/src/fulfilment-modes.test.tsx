// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { AdminShopApplication, FulfilmentModeState } from "@ygo/contracts";
import { FulfilmentModes } from "./fulfilment-modes";
import { adminRoutes } from "./routes";
import { strings } from "./strings";

afterEach(() => cleanup());

const shopId = "00000000-0000-4000-8000-000000000501";
const application = { id: shopId, shopName: "Fresh Mart", state: "live" } as AdminShopApplication;
const modes = (extra: Partial<Record<FulfilmentModeState["mode"], Partial<FulfilmentModeState>>> = {}): { ok: true; data: { modes: FulfilmentModeState[] } } => ({
  ok: true,
  data: { modes: (["instant", "scheduled", "pickup"] as const).map((mode) => ({ mode, shopOn: mode !== "pickup", adminForcedOff: false, open: mode !== "pickup", ...extra[mode] })) },
});
const names = strings.fulfilmentModeNames;

function setup(api: Record<string, unknown>) {
  const router = createMemoryRouter([{ path: "/", loader: () => application, element: <FulfilmentModes api={api as Parameters<typeof FulfilmentModes>[0]["api"]} /> }]);
  render(<RouterProvider router={router} />);
}
const card = async (name: string) => (await screen.findByRole("listitem", { name })) as HTMLElement;

describe("Fulfilment modes screen (#65)", () => {
  it("shows each mode with the shop's own switch, Admin's force-off and whether it takes orders", async () => {
    setup({ shopFulfilmentModes: vi.fn().mockResolvedValue(modes({ scheduled: { adminForcedOff: true, open: false } })) });
    expect(await screen.findByRole("heading", { name: strings.fulfilmentOf("Fresh Mart") })).toBeTruthy();
    const instant = await card(names.instant);
    expect(within(instant).getByText(strings.fulfilmentOn)).toBeTruthy();
    expect(within(instant).getByText(strings.fulfilmentNotForced)).toBeTruthy();
    expect(within(instant).getByText(strings.fulfilmentOpen)).toBeTruthy();
    // Forced off while the shop's own switch stays on.
    const scheduled = await card(names.scheduled);
    expect(within(scheduled).getByText(strings.fulfilmentOn)).toBeTruthy();
    expect(within(scheduled).getByText(strings.fulfilmentForced)).toBeTruthy();
    expect(within(scheduled).getByText(strings.fulfilmentClosed)).toBeTruthy();
    expect(within(scheduled).getByRole("button", { name: strings.fulfilmentRestoreOf(names.scheduled) })).toBeTruthy();
    const pickup = await card(names.pickup);
    expect(within(pickup).getByText(strings.fulfilmentOff)).toBeTruthy();
    expect(within(pickup).getByRole("button", { name: strings.fulfilmentForceOffOf(names.pickup) })).toBeTruthy();
  });

  it("forces a mode off and shows the answer, leaving the shop's own switch as the server reports it", async () => {
    const force = vi.fn().mockResolvedValue(modes({ instant: { adminForcedOff: true, open: false } }));
    setup({ shopFulfilmentModes: vi.fn().mockResolvedValue(modes()), forceFulfilmentMode: force });
    fireEvent.click(within(await card(names.instant)).getByRole("button", { name: strings.fulfilmentForceOffOf(names.instant) }));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: names.instant })).getByText(strings.fulfilmentForced)).toBeTruthy());
    expect(force).toHaveBeenCalledWith(shopId, "instant", true);
    const instant = screen.getByRole("listitem", { name: names.instant });
    expect(within(instant).getByText(strings.fulfilmentOn)).toBeTruthy();
    expect(within(instant).getByText(strings.fulfilmentClosed)).toBeTruthy();
  });

  it("restores a forced-off mode, which stays off when the shop's own switch is off", async () => {
    const restore = vi.fn().mockResolvedValue(modes({ pickup: { shopOn: false, adminForcedOff: false, open: false } }));
    setup({ shopFulfilmentModes: vi.fn().mockResolvedValue(modes({ pickup: { shopOn: false, adminForcedOff: true, open: false } })), forceFulfilmentMode: restore });
    fireEvent.click(within(await card(names.pickup)).getByRole("button", { name: strings.fulfilmentRestoreOf(names.pickup) }));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: names.pickup })).getByText(strings.fulfilmentNotForced)).toBeTruthy());
    expect(restore).toHaveBeenCalledWith(shopId, "pickup", false);
    const pickup = screen.getByRole("listitem", { name: names.pickup });
    expect(within(pickup).getByText(strings.fulfilmentOff)).toBeTruthy();
    expect(within(pickup).getByText(strings.fulfilmentClosed)).toBeTruthy();
  });

  it("disables every button while one change is on its way, so two never race", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const force = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    setup({ shopFulfilmentModes: vi.fn().mockResolvedValue(modes()), forceFulfilmentMode: force });
    fireEvent.click(within(await card(names.instant)).getByRole("button", { name: strings.fulfilmentForceOffOf(names.instant) }));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: names.pickup })).getByRole("button").hasAttribute("disabled")).toBe(true));
    expect(force).toHaveBeenCalledTimes(1);
    finish(modes({ instant: { adminForcedOff: true, open: false } }));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: names.pickup })).getByRole("button").hasAttribute("disabled")).toBe(false));
  });

  it("names a refused change and leaves the modes as they were", async () => {
    setup({ shopFulfilmentModes: vi.fn().mockResolvedValue(modes()), forceFulfilmentMode: vi.fn().mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND" }) });
    fireEvent.click(within(await card(names.instant)).getByRole("button", { name: strings.fulfilmentForceOffOf(names.instant) }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.errors.NOT_FOUND);
    expect(within(screen.getByRole("listitem", { name: names.instant })).getByText(strings.fulfilmentNotForced)).toBeTruthy();
  });

  it("says so when the change cannot reach the server", async () => {
    setup({ shopFulfilmentModes: vi.fn().mockResolvedValue(modes()), forceFulfilmentMode: vi.fn().mockRejectedValue(new Error("offline")) });
    fireEvent.click(within(await card(names.instant)).getByRole("button", { name: strings.fulfilmentForceOffOf(names.instant) }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.failed);
  });

  it("offers Try again when the modes cannot be read, then shows them", async () => {
    const read = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, code: "NOT_FOUND" }).mockResolvedValueOnce(modes());
    setup({ shopFulfilmentModes: read });
    expect((await screen.findByRole("alert")).textContent).toBe(strings.errors.NOT_FOUND);
    fireEvent.click(screen.getByRole("button", { name: strings.retry }));
    await card(names.pickup);
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Fulfilment modes route (#65)", () => {
  const founder = { id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40", email: "asha@example.com", name: "Asha", phone: null, theme: "system", role: "admin" };
  const api = () => ({
    role: vi.fn().mockResolvedValue({ ok: true, data: "admin" }),
    currentRole: vi.fn(() => "admin"),
    getShopApplication: vi.fn().mockResolvedValue({ ok: true, data: application }),
    shopFulfilmentModes: vi.fn().mockResolvedValue(modes()),
    me: vi.fn().mockResolvedValue({ ok: true, data: founder }),
  });

  it("opens from a Live shop's page and reads that shop's modes", async () => {
    const admin = api();
    const router = createMemoryRouter(adminRoutes(admin as unknown as Parameters<typeof adminRoutes>[0]), { initialEntries: [`/applications/${shopId}`] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("link", { name: strings.fulfilmentLink }));
    await card(names.pickup);
    expect(router.state.location.pathname).toBe(`/applications/${shopId}/fulfilment`);
    expect(admin.shopFulfilmentModes).toHaveBeenCalledWith(shopId);
  });

  it("is not offered on a shop that is not Live", async () => {
    const admin = { ...api(), getShopApplication: vi.fn().mockResolvedValue({ ok: true, data: { ...application, state: "approved" } }), shopLiveCheck: vi.fn().mockResolvedValue({ ok: true, data: { blockers: [], rateCardMissing: [] } }) };
    const router = createMemoryRouter(adminRoutes(admin as unknown as Parameters<typeof adminRoutes>[0]), { initialEntries: [`/applications/${shopId}`] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Fresh Mart" });
    expect(screen.queryByRole("link", { name: strings.fulfilmentLink })).toBeNull();
  });
});
