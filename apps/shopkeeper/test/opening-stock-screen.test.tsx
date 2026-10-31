import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  get: vi.fn(), open: vi.fn(), importLegacy: vi.fn(), set: vi.fn(),
  application: vi.fn(), listings: vi.fn(), opening: vi.fn(), pending: vi.fn(),
  failed: vi.fn(), batch: vi.fn(), attempted: vi.fn(), acknowledge: vi.fn(), save: vi.fn(), clear: vi.fn(), attentionCount: vi.fn(), heldPacks: vi.fn(), recover: vi.fn(), versions: vi.fn(),
  state: [] as unknown[], cursor: 0, mounted: false,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.state)) mock.state[index] = initial;
    return [mock.state[index], (value: unknown) => {
      mock.set(value);
      mock.state[index] = typeof value === "function" ? value(mock.state[index]) : value;
    }];
  },
  useEffect: (effect: () => void) => { if (!mock.mounted) { mock.mounted = true; effect(); } },
}));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Text: "Text", SupportEmail: "SupportEmail" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("../src/components/sync-status", () => ({ SyncStatus: "SyncStatus" }));
vi.mock("../src/api", () => ({
  accountEpoch: () => 0,
  session: { get: mock.get }, supportEmail: "help@example.com",
  // An Approved shop: the sync loop sends opening stock but pulls no Stock (#395).
  access: { verify: async () => ({ shopId: "shop-1", state: "approved" }), get: () => ({ mode: "online", accountId: "account-1" }), allowed: () => false },
  api: { shopApplication: mock.application, shopListings: mock.listings, syncActions: mock.opening },
}));
vi.mock("../src/lib/opening-stock-database", () => ({
  openOpeningStock: mock.open, legacyOpeningStock: {},
}));

import OpeningStockScreen from "../src/app/opening-stock";

const entry = { clientId: "00000000-0000-4000-8000-000000000001", quantity: "2.5" };
const item = { packId: "pack-1", name: "Rice", packQuantity: "1", baseUnit: "kg", listing: { id: entry.clientId }, openingStockRecorded: false, stock: "0", held: "0" };
const listings = { ok: true, data: { items: [item] } };
const queue = { failed: mock.failed, batch: mock.batch, attempted: mock.attempted, acknowledge: mock.acknowledge, importLegacy: mock.importLegacy, pending: mock.pending, save: mock.save, clear: mock.clear, attentionCount: mock.attentionCount, heldPacks: mock.heldPacks, recover: mock.recover, versions: mock.versions };
function render() { mock.cursor = 0; return OpeningStockScreen(); }
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }
function switchAccount() {
  mock.get.mockReturnValue({ status: "signed-in", account: { id: "account-2" } });
  mock.set.mockClear();
}
// Search rendered native elements, including nested mapped cards and fragments.
function elements(node: unknown): Array<{ type?: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type?: unknown; props: Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
function press(label: string) {
  const button = elements(render()).find((element) => element.props.label === label);
  expect(button, label).toBeDefined();
  (button?.props.onPress as () => void)();
}

describe("opening-stock account boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mock.state = []; mock.cursor = 0; mock.mounted = false;
    mock.get.mockReturnValue({ status: "signed-in", account: { id: "account-1" } });
    mock.application.mockResolvedValue({ ok: true, data: { application: { id: "shop-1" } } });
    mock.listings.mockResolvedValue(listings);
    mock.open.mockResolvedValue(queue);
    mock.failed.mockReturnValue(null);
    mock.batch.mockImplementation(() => ({ deviceId: "device", sentAt: new Date().toISOString(), actions: mock.heldPacks().length || !mock.pending() ? [] : [{ id: entry.clientId, sequence: 1 }] }));
    mock.pending.mockReturnValue(null); mock.attentionCount.mockReturnValue(0); mock.heldPacks.mockReturnValue([]); mock.versions.mockReturnValue([{ payload: JSON.stringify(entry), entry }, { payload: "broken bytes", entry: null }]);
  });

  it("shows a recorded pack's stock left after accepted orders, with what they hold (#436)", async () => {
    mock.listings.mockResolvedValue({ ok: true, data: { items: [{ ...item, openingStockRecorded: true, stock: "1.000", held: "2.000" }] } });
    render(); await settle();
    expect(elements(render()).map((node) => node.props.children)).toContain("Saved. 1 kg left · 2 kg held for orders");
  });

  it("does not import legacy work when the account changes while its database opens", async () => {
    mock.open.mockImplementation(async () => { switchAccount(); return queue; });
    render(); await settle();
    expect(mock.open).toHaveBeenCalledWith("account-1");
    expect(mock.importLegacy).not.toHaveBeenCalled();
    expect(mock.set).not.toHaveBeenCalled();
  });

  it("ignores listing errors from a previous account", async () => {
    mock.listings.mockImplementation(async () => { switchAccount(); throw new Error("offline"); });
    render(); await settle();
    expect(mock.open).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled();
  });

  it("ignores database errors from a previous account", async () => {
    mock.open.mockImplementation(async () => { switchAccount(); throw new Error("key"); });
    render(); await settle();
    expect(mock.set).not.toHaveBeenCalled();
  });

  it("ignores startup sync results after the account changes", async () => {
    mock.pending.mockReturnValue(entry);
    mock.opening.mockImplementation(async () => { switchAccount(); return { ok: false, code: "VALIDATION_FAILED" }; });
    render(); await settle();
    expect(mock.opening).toHaveBeenCalledOnce(); expect(mock.set).not.toHaveBeenCalled();
  });

  it.each([true, false])("ignores a startup listing refresh after sync (success=%s)", async (success) => {
    mock.pending.mockReturnValue(entry);
    mock.opening.mockResolvedValue(success ? { ok: true, data: { results: [{ actionId: entry.clientId, sequence: 1, status: "applied", code: null, result: { listingId: entry.clientId, quantity: "2.5", recordedAt: new Date().toISOString() }, clockSuspect: false }] } } : { ok: true, data: { results: [{ actionId: entry.clientId, sequence: 1, status: "rejected", code: "OPENING_STOCK_ALREADY_RECORDED", result: null, clockSuspect: false }] } });
    mock.listings.mockResolvedValueOnce(listings).mockImplementationOnce(async () => { switchAccount(); return listings; });
    render(); await settle();
    expect(mock.listings).toHaveBeenCalledTimes(2); expect(mock.set).not.toHaveBeenCalled();
  });

  it.each([true, false])("ignores a save response after switching accounts (success=%s)", async (success) => {
    render(); await settle();
    mock.pending.mockReturnValue(entry);
    mock.opening.mockImplementation(async () => { switchAccount(); return success ? { ok: true, data: { quantity: "2.5" } } : { ok: false, code: "VALIDATION_FAILED" }; });
    press("Save opening stock"); await settle();
    expect(mock.save).toHaveBeenCalledOnce(); expect(mock.set).not.toHaveBeenCalled();
  });

  it("ignores a listing refresh after a save conflict when the account changes", async () => {
    render(); await settle(); mock.pending.mockReturnValue(entry);
    mock.opening.mockResolvedValue({ ok: true, data: { results: [{ actionId: entry.clientId, sequence: 1, status: "rejected", code: "OPENING_STOCK_ALREADY_RECORDED", result: null, clockSuspect: false }] } });
    mock.listings.mockImplementation(async () => { switchAccount(); return listings; });
    press("Save opening stock"); await settle();
    expect(mock.set).not.toHaveBeenCalled();
  });

  it("ignores a manual conflict-refresh result after the account changes", async () => {
    mock.pending.mockReturnValue(entry);
    mock.opening.mockResolvedValue({ ok: true, data: { results: [{ actionId: entry.clientId, sequence: 1, status: "rejected", code: "OPENING_STOCK_ALREADY_RECORDED", result: null, clockSuspect: false }] } });
    mock.listings.mockResolvedValueOnce(listings).mockResolvedValueOnce({ ok: false, code: "UNAVAILABLE" });
    render(); await settle();
    mock.listings.mockImplementation(async () => { switchAccount(); return listings; });
    press("Try again"); await settle();
    expect(mock.set).not.toHaveBeenCalled();
  });
  it("updates every listing acknowledged by a save's batch", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    const second = { ...item, packId: "pack-2", name: "Dal", listing: { id: secondId } };
    mock.listings.mockResolvedValue({ ok: true, data: { items: [item, second] } });
    render(); await settle();
    mock.pending.mockImplementation((_shop: string, pack: string) => ({ ...entry, clientId: pack === item.packId ? entry.clientId : secondId }));
    mock.batch.mockReturnValue({ deviceId: "device", sentAt: new Date().toISOString(), actions: [{ id: entry.clientId, sequence: 1 }, { id: secondId, sequence: 2 }] });
    mock.opening.mockResolvedValue({ ok: true, data: { results: [entry.clientId, secondId].map((id, index) => ({ actionId: id, sequence: index + 1,
      status: "applied", code: null, result: { listingId: id, quantity: "2.5", recordedAt: new Date().toISOString() }, clockSuspect: false })) } });
    press("Save opening stock"); await settle();
    expect(mock.opening).toHaveBeenCalledOnce();
    expect(elements(render()).filter((node) => node.props.label === "Save opening stock")).toHaveLength(0);
  });

  it("requires recovery before automatically syncing a conflicting active version", async () => {
    mock.heldPacks.mockReturnValue([item.packId]); mock.pending.mockReturnValue(entry);
    render(); await settle();
    expect(mock.opening).not.toHaveBeenCalled();
    expect(elements(render()).find((node) => node.props.label === "Save opening stock")?.props.disabled).toBe(true);
  });

  it("queues a valid recovery and keeps invalid or failed corrections visible", async () => {
    mock.heldPacks.mockReturnValue([item.packId]);
    render(); await settle();
    const recovery = elements(render()).find((node) => node.props.packId === item.packId);
    const recover = recovery?.props.onRecover as (pack: string, quantity: string, chosen: typeof entry | null) => string | null;
    expect(recover(item.packId, "bad", null)).toContain("valid quantity");
    expect(mock.recover).not.toHaveBeenCalled();
    mock.recover.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(recover(item.packId, entry.quantity, entry)).toContain("Couldn't open or save");
    expect(recover(item.packId, entry.quantity, entry)).toBeNull();
    expect(mock.recover).toHaveBeenLastCalledWith("shop-1", item.packId, item.packId, entry);
    switchAccount();
    expect(recover(item.packId, entry.quantity, entry)).toContain("Couldn't open or save");
    expect(mock.recover).toHaveBeenCalledTimes(2);
  });

  it("shows original bytes and support, and allows choosing or correcting a saved version", async () => {
    mock.heldPacks.mockReturnValue([item.packId]);
    render(); await settle();
    const node = elements(render()).find((element) => element.props.packId === item.packId);
    const Recovery = node?.type as (props: Record<string, unknown>) => unknown;
    mock.state = [];
    const recover = vi.fn().mockReturnValue(null);
    function form() {
      mock.cursor = 0;
      return Recovery({ ...node?.props, onRecover: recover });
    }
    const initial = elements(form());
    expect(initial.some((node) => node.props.children === "broken bytes" && node.props.selectable)).toBe(true);
    expect(initial.some((node) => node.props.address === "help@example.com")).toBe(true);
    (initial.find((node) => node.props.label === "Use saved quantity 2.5")?.props.onPress as () => void)();
    (elements(form()).find((node) => node.props.label === "Keep recovered quantity")?.props.onPress as () => void)();
    expect(recover).toHaveBeenLastCalledWith(item.packId, "2.5", entry);
    (elements(form()).find((node) => node.props.accessibilityLabel === "Recovered quantity in base units")?.props.onChangeText as (value: string) => void)("7");
    (elements(form()).find((node) => node.props.label === "Keep recovered quantity")?.props.onPress as () => void)();
    expect(recover).toHaveBeenLastCalledWith(item.packId, "7", null);
  });

});
