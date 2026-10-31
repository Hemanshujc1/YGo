import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  get: vi.fn(), open: vi.fn(), importLegacy: vi.fn(), set: vi.fn(),
  application: vi.fn(), listings: vi.fn(), opening: vi.fn(), pending: vi.fn(),
  failed: vi.fn(), batch: vi.fn(), attempted: vi.fn(), acknowledge: vi.fn(), save: vi.fn(), clear: vi.fn(), attentionCount: vi.fn(), heldPacks: vi.fn(), recover: vi.fn(), versions: vi.fn(), saveCorrection: vi.fn(), corrections: vi.fn(),
  state: [] as unknown[], cursor: 0, effect: 0, effects: [] as Array<{ deps: unknown[]; cleanup?: unknown }>,
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
  // Runs an effect again only when its dependencies change, after the previous one's cleanup.
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = mock.effect++, before = mock.effects[index];
    if (before && deps.every((value, i) => Object.is(value, before.deps[i]))) return;
    if (typeof before?.cleanup === "function") before.cleanup();
    mock.effects[index] = { deps, cleanup: effect() };
  },
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
  access: { verify: async () => ({ shopId: "shop-1", state: "approved" }), get: () => ({ mode: "online", accountId: "account-1" }), allowed: () => false, answer: () => null },
  api: { shopApplication: mock.application, shopListings: mock.listings, syncActions: mock.opening },
}));
vi.mock("../src/lib/opening-stock-database", () => ({
  openOpeningStock: mock.open, legacyOpeningStock: {},
}));

import OpeningStockScreen from "../src/app/opening-stock";
import { stockSync } from "../src/lib/stock-sync";
import { strings } from "../src/strings";

const entry = { clientId: "00000000-0000-4000-8000-000000000001", quantity: "2.5" };
const item = { packId: "pack-1", name: "Rice", packQuantity: "1", baseUnit: "kg", listing: { id: entry.clientId }, openingStockRecorded: false, stock: "0", held: "0" };
const listings = { ok: true, data: { items: [item] } };
const queue = { failed: mock.failed, batch: mock.batch, attempted: mock.attempted, acknowledge: mock.acknowledge, importLegacy: mock.importLegacy, pending: mock.pending, save: mock.save, clear: mock.clear, attentionCount: mock.attentionCount, heldPacks: mock.heldPacks, recover: mock.recover, versions: mock.versions, saveCorrection: mock.saveCorrection, corrections: mock.corrections };
function render() { mock.cursor = 0; mock.effect = 0; return OpeningStockScreen(); }
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }
function switchAccount() {
  mock.get.mockReturnValue({ status: "signed-in", account: { id: "account-2" } });
  mock.set.mockClear();
}
// Search rendered native elements, including nested mapped cards, fragments and the Attention lines (#464).
// Recovery stays one element: its tests press its props directly.
function elements(node: unknown): Array<{ type?: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type?: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function" && element.type.name === "Attention") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
function press(label: string) {
  const button = elements(render()).find((element) => element.props.label === label);
  expect(button, label).toBeDefined();
  (button?.props.onPress as () => void)();
}

describe("opening-stock account boundary", () => {
  beforeEach(() => {
    for (const { cleanup } of mock.effects) if (typeof cleanup === "function") cleanup();
    vi.resetAllMocks(); mock.state = []; mock.cursor = 0; mock.effects = [];
    mock.corrections.mockReturnValue({});
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

  it("shows a refused first count with its support reference, like a refused correction (#464)", async () => {
    mock.pending.mockReturnValue(entry);
    mock.failed.mockReturnValue({ actionId: entry.clientId, sequence: 1, status: "rejected", code: "VALIDATION_FAILED", result: null, clockSuspect: false });
    mock.batch.mockReturnValue({ deviceId: "device", sentAt: new Date().toISOString(), actions: [] });
    render(); await settle();
    const texts = elements(render()).map((node) => [node.props.children].flat().join(""));
    expect(texts).toContain(strings.shopSetup.syncAttention);
    expect(texts).toContain(`Support reference: ${entry.clientId}`);
    expect(texts).not.toContain(entry.clientId);
  });

  describe("correcting a recorded count (#452)", () => {
    const recorded = { ...item, openingStockRecorded: true, stock: "10.000", openingStock: "10.000" };
    const box = () => elements(render()).filter((node) => node.type === "TextInput")[0]?.props ?? {};
    const open = async () => {
      mock.listings.mockResolvedValue({ ok: true, data: { items: [recorded] } });
      render(); await settle();
      press("Correct opening stock");
    };

    const lines = () => elements(render()).map((node) => [node.props.children].flat().join(""));
    const correction = (status: string, quantity: string, code: string | null = null) => ({ "pack-1": { id: "correction-1", status, quantity, code } });

    it("opens the box with the recorded count, trims what is typed, queues the corrected total and fetches the new figures once it syncs", async () => {
      await open();
      expect(box().value).toBe("10");
      (box().onChangeText as (value: string) => void)("8.250");
      (box().onBlur as () => void)();
      expect(box().value).toBe("8.25");
      mock.saveCorrection.mockReturnValue({ id: "correction-1" });
      mock.batch.mockReturnValue({ deviceId: "device", sentAt: new Date().toISOString(), actions: [{ id: "correction-1", sequence: 1 }] });
      mock.opening.mockResolvedValue({ ok: true, data: { results: [{ actionId: "correction-1", sequence: 1, status: "applied", code: null,
        result: { listingId: entry.clientId, quantity: "8.250", recordedAt: new Date().toISOString() }, clockSuspect: false }] } });
      mock.listings.mockResolvedValue({ ok: true, data: { items: [{ ...recorded, stock: "8.250", openingStock: "8.250" }] } });
      mock.saveCorrection.mockImplementation(() => { mock.corrections.mockReturnValue(correction("pending", "8.25")); return { id: "correction-1" }; });
      mock.acknowledge.mockImplementation(() => mock.corrections.mockReturnValue(correction("applied", "8.25")));
      press("Save correction"); await settle(); await settle();
      expect(mock.saveCorrection).toHaveBeenCalledWith("shop-1", "pack-1", "8.25");
      const texts = lines();
      expect(texts).toContain("Opening stock corrected.");
      expect(texts).toContain("Saved. 8.25 kg left");
      expect(mock.listings).toHaveBeenCalledTimes(2);
      expect(elements(render()).filter((node) => node.type === "TextInput")).toHaveLength(0);
    });

    it("says a correction made offline is waiting, and shows a refusal in words", async () => {
      await open();
      (box().onChangeText as (value: string) => void)("8");
      mock.saveCorrection.mockReturnValue({ id: "correction-1" });
      mock.batch.mockReturnValue({ deviceId: "device", sentAt: new Date().toISOString(), actions: [] });
      press("Save correction"); await settle();
      mock.corrections.mockReturnValue(correction("pending", "8"));
      expect(lines()).toContain("Correction to 8 kg is waiting to sync.");
      // Correct again starts from the total still waiting, not the synced one (#460).
      press("Correct opening stock");
      expect(box().value).toBe("8");
      mock.saveCorrection.mockReturnValue("queueFull");
      press("Save correction"); await settle();
      expect(lines()).toContain(strings.stock.queueFull);
    });

    it("shows a refused correction on its pack with the reason and reference until a newer one is queued (#460)", async () => {
      mock.corrections.mockReturnValue(correction("rejected", "4.000", "ACTION_TOO_OLD"));
      await open();
      expect(lines()).toContain("Correction to 4 kg wasn't saved: This change waited too long to sync, so the server refused it.");
      expect(lines()).toContain("Support reference: correction-1");
      mock.corrections.mockReturnValue(correction("pending", "5"));
      expect(lines()).not.toContain("Correction to 4 kg wasn't saved: This change waited too long to sync, so the server refused it.");
    });

    it("fetches a synced correction's figures again after the next pass when the first fetch fails (#460)", async () => {
      mock.corrections.mockReturnValue(correction("pending", "12"));
      await open();
      mock.corrections.mockReturnValue(correction("applied", "12"));
      mock.listings.mockResolvedValueOnce({ ok: false, code: "UNAVAILABLE" });
      await stockSync.run(); await settle();
      expect(lines()).toContain("Saved. 10 kg left");
      mock.listings.mockResolvedValueOnce({ ok: true, data: { items: [{ ...recorded, stock: "12.000", openingStock: "12.000" }] } });
      await stockSync.run(); await settle();
      expect(lines()).toContain("Saved. 12 kg left");
      await stockSync.run(); await settle();
      expect(mock.listings).toHaveBeenCalledTimes(3);
    });

    it("keeps a pack's left figure when its correction syncs in the batch of another pack's first count, then fetches it (#460)", async () => {
      const first = { ...item, packId: "pack-2", name: "Dal", listing: { id: "listing-2" } };
      mock.listings.mockResolvedValue({ ok: true, data: { items: [{ ...recorded, stock: "6.000", held: "4.000" }, first] } });
      mock.corrections.mockReturnValue(correction("pending", "12"));
      render(); await settle();
      mock.pending.mockImplementation((_shop: string, pack: string) => pack === "pack-2" ? entry : null);
      mock.batch.mockReturnValue({ deviceId: "device", sentAt: new Date().toISOString(), actions: [{ id: "correction-1", sequence: 1 }, { id: entry.clientId, sequence: 2 }] });
      mock.opening.mockResolvedValue({ ok: true, data: { results: [
        { actionId: "correction-1", sequence: 1, status: "applied", code: null, result: { listingId: entry.clientId, quantity: "12.000", recordedAt: new Date().toISOString() }, clockSuspect: false },
        { actionId: entry.clientId, sequence: 2, status: "applied", code: null, result: { listingId: "listing-2", quantity: "2.5", recordedAt: new Date().toISOString() }, clockSuspect: false }] } });
      let release: () => void = () => undefined;
      mock.listings.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, data: { items: [{ ...recorded, stock: "8.000", held: "4.000", openingStock: "12.000" }] } }); }));
      mock.acknowledge.mockImplementation(() => mock.corrections.mockReturnValue(correction("applied", "12")));
      press("Save opening stock"); await settle();
      expect(lines()).toContain("Saved. 6 kg left · 4 kg held for orders");
      expect(lines()).toContain("Saved. 2.5 kg left");
      release(); await settle();
      expect(lines()).toContain("Saved. 8 kg left · 4 kg held for orders");
    });

    it("refuses an empty total without queueing", async () => {
      await open();
      (box().onChangeText as (value: string) => void)("");
      press("Save correction"); await settle();
      expect(mock.saveCorrection).not.toHaveBeenCalled();
    });
  });

  it("shows pack sizes and typed amounts without trailing zeros (#451)", async () => {
    mock.listings.mockResolvedValue({ ok: true, data: { items: [{ ...item, packQuantity: "1.000" }] } });
    render(); await settle();
    expect(elements(render()).map((node) => [node.props.children].flat().join(""))).toContain("Rice · 1 kg");
    const box = () => elements(render()).filter((node) => node.type === "TextInput")[0]?.props ?? {};
    (box().onChangeText as (value: string) => void)("2.500");
    expect(box().value).toBe("2.500");
    (box().onBlur as () => void)();
    expect(box().value).toBe("2.5");
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
