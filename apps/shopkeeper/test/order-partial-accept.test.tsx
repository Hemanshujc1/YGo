import type { PartialAcceptPreviewResponse, ShopOrderLine, ShopOrderResponse } from "@ygo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void>,
  view: null as unknown,
  ordersView: null as unknown,
  ordersViewActive: false,
  previewCalls: [] as unknown[],
  cancelsOrder: false,
  partialAcceptCalls: [] as unknown[],
  customPreview: null as null | ((lines: unknown) => Promise<unknown>),
  customPartialAccept: null as null | ((lines: unknown) => Promise<unknown>),
}));

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) {
      mock.hooks[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return [
      mock.hooks[index],
      (next: unknown) => {
        mock.hooks[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(mock.hooks[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) {
      mock.hooks[index] = { current: initial };
    }
    return mock.hooks[index] as { current: unknown };
  },
  useSyncExternalStore: (subscribe: (cb: () => void) => () => void, get: () => unknown) => {
    return mock.ordersViewActive ? mock.ordersView : (mock.view ?? get());
  },
  useEffect: (effect: () => unknown, deps?: unknown[]) => {
    const index = mock.cursor++;
    const prev = mock.hooks[index] as { deps?: unknown[]; cleanup?: () => void } | undefined;
    const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
    if (changed) {
      mock.effects.push(() => {
        prev?.cleanup?.();
        const cleanup = effect();
        mock.hooks[index] = { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined };
      });
    }
  },
}));

vi.mock("expo-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
  router: { replace: vi.fn() },
  useLocalSearchParams: () => ({ id: "order-1" }),
}));

vi.mock("@ygo/mobile", () => ({
  Button: (props: Record<string, unknown>) => ({ type: "Button", props }),
  Confirm: (props: Record<string, unknown>) => ({ type: "Confirm", props }),
  StatusChip: (props: Record<string, unknown>) => ({ type: "StatusChip", props }),
  Text: (props: Record<string, unknown>) => ({ type: "Text", props }),
  useInFront: () => undefined,
}));

vi.mock("@ygo/mobile/notification-parts", () => ({
  NotificationsBell: "NotificationsBell",
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "Spinner",
  Image: "Image",
  Linking: {},
  Modal: ({ children, visible }: { children: unknown; visible: boolean }) => (visible ? children : null),
  Pressable: (props: Record<string, unknown>) => ({ type: "Pressable", props }),
  RefreshControl: "RefreshControl",
  ScrollView: ({ children }: { children: unknown }) => ({ type: "ScrollView", props: { children } }),
  TextInput: "TextInput",
  View: (props: Record<string, unknown>) => ({ type: "View", props }),
}));

vi.mock("expo-camera", () => ({
  CameraView: "CameraView",
  useCameraPermissions: () => [null, () => Promise.resolve({ granted: false })],
}));

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  manipulateAsync: () => Promise.resolve({ uri: "" }),
}));

vi.mock("react-native-qrcode-svg", () => ({ default: "QRCode" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("../src/lib/delivery-cache", () => ({ deliveryCache: {}, openDelivery: () => Promise.resolve(null) }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: () => () => undefined, get: () => ({ running: false, outcome: null }), run: () => Promise.resolve(null) } }));
vi.mock("../src/api", () => ({
  api: {},
  access: { role: () => "owner", answer: () => ({ state: "live" }) },
  session: { get: () => ({ account: { id: "owner-1" } }) },
}));

vi.mock("../src/components/countdown", () => ({
  Countdown: (props: { seconds: number }) => ({ type: "Countdown", props }),
  ExpiryCountdown: (props: { expiresAt: string | null; offset: number }) => ({ type: "ExpiryCountdown", props }),
  useSecondsLeft: (expiresAt: string | null) => (expiresAt ? 120 : null),
}));

vi.mock("../src/components/icons", () => ({
  Minus: (props: Record<string, unknown>) => ({ type: "Minus", props }),
  Plus: (props: Record<string, unknown>) => ({ type: "Plus", props }),
}));

vi.mock("../src/components/alert-panel", () => ({ AlertPanel: "AlertPanel" }));
vi.mock("../src/components/open-switch", () => ({ OpenSwitch: "OpenSwitch" }));
vi.mock("../src/lib/account-role", () => ({ useAccountRole: () => "owner" }));
vi.mock("../src/lib/inbox", () => ({ inbox: {} }));

vi.mock("../src/components/order-row", () => ({
  OrderRow: (props: Record<string, unknown>) => ({ type: "OrderRow", props }),
}));

vi.mock("../src/lib/shop-orders", async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  createShopOrder: () => ({
    subscribe: () => () => undefined,
    get: () => mock.view,
    refresh: vi.fn(),
    retry: vi.fn(),
    accept: vi.fn().mockResolvedValue(true),
    reject: vi.fn().mockResolvedValue(true),
    previewPartialAccept: vi.fn((lines: unknown) => {
      mock.previewCalls.push(lines);
      if (mock.customPreview) {
        return mock.customPreview(lines);
      }
      return Promise.resolve({
        ok: true,
        data: {
          productValue: "150.00",
          deliveryFee: "30.00",
          smallCartFee: null,
          pickupFee: null,
          total: "180.00",
          originalTotal: "230.00",
          cancelsOrder: mock.cancelsOrder,
          belowFloor: false,
          shopDiscount: null,
        } satisfies PartialAcceptPreviewResponse,
      });
    }),
    partialAccept: vi.fn((lines: unknown) => {
      mock.partialAcceptCalls.push(lines);
      if (mock.customPartialAccept) {
        return mock.customPartialAccept(lines);
      }
      return Promise.resolve(true);
    }),
  }),
  createShopOrders: () => ({
    subscribe: () => () => undefined,
    get: () => mock.ordersView,
    refresh: vi.fn(),
    retry: vi.fn(),
  }),
}));

import OrderScreen from "../src/app/orders/[id]";
import OrdersScreen from "../src/app/orders/index";
import { strings } from "../src/strings";

const words = strings.orders;

const dalListingId = "00000000-0000-4000-8000-000000000001";
const oilListingId = "00000000-0000-4000-8000-000000000002";

const lines: ShopOrderLine[] = [
  {
    listingId: dalListingId,
    name: "Toor Dal",
    brand: "Tata",
    baseUnit: "kg",
    quantity: "1",
    count: 2,
    part: null,
    unitPrice: "100.00",
    lineTotal: "200.00",
  },
  {
    listingId: oilListingId,
    name: "Mustard Oil",
    brand: "Fortune",
    baseUnit: "l",
    quantity: "1",
    count: 1,
    part: "0.5",
    unitPrice: "30.00",
    lineTotal: "30.00",
  },
];

const placedOrder: ShopOrderResponse = {
  id: "order-1",
  number: 101,
  status: "placed",
  placedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:10:00.000Z",
  productValue: "200.00",
  deliveryFee: "30.00",
  smallCartFee: null,
  pickupFee: null,
  total: "230.00",
  deliveryPhotoAvailable: false,
  lines,
  now: "2030-01-01T00:02:00.000Z",
  customer: { name: "Ananya", phone: "+919876543210" },
  fulfilment: "delivery",
  address: { label: "home", flat: "402", areaLine: "MG Road", pincode: "560001" },
  rejectReason: null,
  cancelRequest: null,
  proposal: null,
  confirmByAt: null,
  shopUpiId: null,
  delivererId: null,
  deliveryFailureReadyAt: null,
};

type Node = { type: unknown; props: Record<string, unknown> };

function elements(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Node;
  if (typeof el.type === "function") return elements((el.type as (p: unknown) => unknown)(el.props));
  return [el, ...elements(el.props.children)];
}

function render() {
  mock.cursor = 0;
  const tree = OrderScreen();
  for (const effect of mock.effects.splice(0)) effect();
  return tree;
}

const findNodes = (predicate: (props: Record<string, unknown>) => boolean) =>
  elements(render()).filter((node) => predicate(node.props));

const findNode = (predicate: (props: Record<string, unknown>) => boolean) =>
  elements(render()).find((node) => predicate(node.props));

const textOf = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (!node || typeof node !== "object") return [];
  const n = node as Node;
  const children = n.props?.children;
  const current = typeof children === "string" ? [children] : [];
  return [...current, ...textOf(children)];
};

const allTexts = () => elements(render()).flatMap((n) => textOf(n));

function selectReason(reasonText: string) {
  const radio = findNodes((p) => p.accessibilityRole === "radio").find((n) => textOf(n).includes(reasonText));
  expect(radio).toBeDefined();
  (radio?.props.onPress as () => void)();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("S05 Accept in part: Steppers, reasons, preview, and submit (#527)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.hooks = [];
    mock.effects = [];
    mock.previewCalls = [];
    mock.cancelsOrder = false;
    mock.partialAcceptCalls = [];
    mock.customPreview = null;
    mock.customPartialAccept = null;
    mock.ordersViewActive = false;
    mock.view = {
      status: "ready",
      order: placedOrder,
      offset: 0,
      expired: false,
      message: null,
      refreshing: false,
      notice: null,
      shortLines: [],
      answering: null,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Accept, Accept in part, and Reject buttons on placed orders", () => {
    const buttons = findNodes((p) => typeof p.label === "string");
    const labels = buttons.map((b) => b.props.label);

    expect(labels).toContain(words.accept);
    expect(labels).toContain(words.acceptInPart);
    expect(labels).toContain(words.reject);

    // Reject has destructive-outline variant
    const rejectBtn = buttons.find((b) => b.props.label === words.reject);
    expect(rejectBtn?.props.variant).toBe("destructive-outline");
  });

  it("stepper limits: caps count at original count and minimum 0; part toggles 1 or 0", () => {
    // 1. Enter edit mode
    const acceptInPartBtn = findNode((p) => p.label === words.acceptInPart);
    expect(acceptInPartBtn).toBeDefined();
    (acceptInPartBtn?.props.onPress as () => void)();

    // In edit mode: "Send new total to customer" is disabled because nothing changed
    const sendBtn = findNode((p) => p.label === words.sendNewTotal);
    expect(sendBtn?.props.disabled).toBe(true);

    // Plus button for Dal (original count = 2) should be disabled initially
    const plusBtns = findNodes((p) => p.accessibilityLabel === words.increaseCount);
    expect(plusBtns[0]?.props.disabled).toBe(true);

    // Minus button reduces count from 2 to 1
    const minusBtns = findNodes((p) => p.accessibilityLabel === words.reduceCount);
    expect(minusBtns[0]?.props.disabled).toBe(false);
    (minusBtns[0]?.props.onPress as () => void)();

    // Now count is 1. Plus button is enabled.
    const updatedPlus = findNodes((p) => p.accessibilityLabel === words.increaseCount);
    expect(updatedPlus[0]?.props.disabled).toBe(false);

    // Minus button reduces count to 0
    const updatedMinus = findNodes((p) => p.accessibilityLabel === words.reduceCount);
    (updatedMinus[0]?.props.onPress as () => void)();

    // At 0, minus button is disabled (capped at 0)
    const zeroMinus = findNodes((p) => p.accessibilityLabel === words.reduceCount);
    expect(zeroMinus[0]?.props.disabled).toBe(true);

    // Part-of-pack line: Remove button toggles to 0
    const removeBtns = findNodes((p) => p.label === words.removeLine);
    expect(removeBtns.length).toBeGreaterThan(0);
    // Tap Remove on the part line (Oil)
    (removeBtns[removeBtns.length - 1]?.props.onPress as () => void)();

    // Now oil has Undo button (toggles back to 1)
    const undoBtns = findNodes((p) => p.label === words.undoLine);
    expect(undoBtns.length).toBeGreaterThan(0);
  });

  it("reasons: lowering or removing a line opens reason sheet with 4 contract reasons and no Other", () => {
    // Enter edit mode
    const acceptInPartBtn = findNode((p) => p.label === words.acceptInPart);
    (acceptInPartBtn?.props.onPress as () => void)();

    // Step down Dal
    const minusBtns = findNodes((p) => p.accessibilityLabel === words.reduceCount);
    (minusBtns[0]?.props.onPress as () => void)();

    // Reason sheet should open
    const sheetTitle = findNode((p) => p.children === words.reasonSheetTitle);
    expect(sheetTitle).toBeDefined();

    // The 4 contract reasons are available
    expect(words.lineChangeReasons.out_of_stock).toBe("Out of stock");
    expect(words.lineChangeReasons.damaged).toBe("Damaged");
    expect(words.lineChangeReasons.near_expiry).toBe("Near expiry");
    expect(words.lineChangeReasons.quality_issue).toBe("Quality issue");

    // Select "Out of stock"
    selectReason("Out of stock");

    // The line now displays the reason chip
    const chip = findNode((p) => p.accessibilityLabel === "Out of stock");
    expect(chip).toBeDefined();
  });

  it("send-disabled rules: disabled when nothing changed, missing reason, or no lines remain", () => {
    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // 1. Nothing changed: disabled
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);

    // 2. Reduce Dal from 2 to 1 (without choosing reason yet)
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();

    // Close reason sheet without choosing (cancel)
    const cancelReason = findNode((p) => p.label === words.reasonCancel);
    (cancelReason?.props.onPress as () => void)();

    // Send should remain disabled because Dal is missing a reason
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);

    // Re-open reason by tapping reason chip
    const reasonChip = findNode((p) => p.accessibilityLabel === words.reasonSheetTitle);
    (reasonChip?.props.onPress as () => void)();

    // Choose reason
    selectReason("Out of stock");

    // 3. Remove all remaining lines (oil removed, dal to 0)
    // Dal to 0:
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    // Oil removed:
    (findNodes((p) => p.label === words.removeLine)[0]?.props.onPress as () => void)();
    // Choose reason for oil:
    selectReason("Out of stock");

    // Now all lines have count = 0 (no lines remain) -> Send disabled
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);

    // Undo Dal back to 2
    (findNodes((p) => p.label === words.undoLine)[0]?.props.onPress as () => void)();

    // "Cancel changes" leaves edit mode
    const cancelChangesBtn = findNode((p) => p.label === words.cancelChanges);
    expect(cancelChangesBtn).toBeDefined();
    (cancelChangesBtn?.props.onPress as () => void)();

    // Back to normal placed order view
    expect(findNode((p) => p.label === words.acceptInPart)).toBeDefined();
  });

  it("preview totals: debounced call fetches quote from server and shows struck-through old total", async () => {
    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Step down Dal
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    // Pick reason
    selectReason("Out of stock");

    // Run timer to fire debounced preview call
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Verify previewPartialAccept was called with Dal count 1
    expect(mock.previewCalls.length).toBeGreaterThan(0);
    expect(mock.previewCalls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ listingId: dalListingId, count: 1 })]),
    );

    // Renders the server's preview total (180) with original total (230) struck through
    const texts = allTexts();
    expect(texts).toContain("₹230");
    expect(texts).toContain("₹180");
  });

  it("preview that would cancel the order shows the warning and keeps Send enabled", async () => {
    mock.cancelsOrder = true;
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();
    expect(allTexts()).toContain(words.cancelsOrderWarning);
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBeFalsy();
  });

  it("submit body: sends proposed lines with reductions and reasons to partialAccept", async () => {
    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Step down Dal
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    // Pick reason
    selectReason("Out of stock");

    // Debounce preview
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Tap "Send new total to customer"
    const sendBtn = findNode((p) => p.label === words.sendNewTotal);
    expect(sendBtn?.props.disabled).toBe(false);
    await (sendBtn?.props.onPress as () => Promise<void>)();

    // partialAccept called with changed lines
    expect(mock.partialAcceptCalls).toHaveLength(1);
    expect(mock.partialAcceptCalls[0]).toEqual([
      { listingId: dalListingId, count: 1, reason: "out_of_stock" },
    ]);
  });

  it("out-of-order preview responses: older in-flight preview resolving late does not overwrite latest preview", async () => {
    const d1 = deferred<{ ok: boolean; data: PartialAcceptPreviewResponse }>();
    const d2 = deferred<{ ok: boolean; data: PartialAcceptPreviewResponse }>();

    mock.customPreview = (lines: unknown) => {
      const arr = lines as Array<{ listingId: string; count: number }>;
      const dal = arr.find((l) => l.listingId === dalListingId);
      if (dal?.count === 1) return d1.promise;
      if (dal?.count === 0) return d2.promise;
      return Promise.resolve({
        ok: true,
        data: {
          productValue: "150.00",
          deliveryFee: "30.00",
          smallCartFee: null,
          total: "180.00",
          originalTotal: "230.00",
        },
      });
    };

    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Step down Dal: 2 -> 1
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");

    // Advance timer so preview request 1 (Dal count 1) is fired
    render();
    vi.advanceTimersByTime(300);

    // Step down Dal again: 1 -> 0
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();

    // Advance timer so preview request 2 (Dal count 0) is fired
    render();
    vi.advanceTimersByTime(300);

    // While both are in-flight, send should be disabled and preview is null
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);

    // Request 2 resolves FIRST (latest proposal, total = 100)
    d2.resolve({
      ok: true,
      data: {
        productValue: "70.00",
        deliveryFee: "30.00",
        smallCartFee: null,
        pickupFee: null,
        total: "100.00",
        originalTotal: "230.00",
        cancelsOrder: false,
        belowFloor: false,
        shopDiscount: null,
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Latest total is shown and send is enabled
    expect(allTexts()).toContain("₹100");
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(false);

    // Request 1 resolves OUT-OF-ORDER (outdated proposal, total = 180)
    d1.resolve({
      ok: true,
      data: {
        productValue: "150.00",
        deliveryFee: "30.00",
        smallCartFee: null,
        pickupFee: null,
        total: "180.00",
        originalTotal: "230.00",
        cancelsOrder: false,
        belowFloor: false,
        shopDiscount: null,
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Outdated request 1 does NOT overwrite preview total
    expect(allTexts()).toContain("₹100");
    expect(allTexts()).not.toContain("₹180");

    // Submitting sends the current proposal (count 0), not the stale one (count 1)
    const sendBtn = findNode((p) => p.label === words.sendNewTotal);
    expect(sendBtn?.props.disabled).toBe(false);
    await (sendBtn?.props.onPress as () => Promise<void>)();

    expect(mock.partialAcceptCalls[0]).toEqual([
      { listingId: dalListingId, count: 0, reason: "out_of_stock" },
    ]);
  });

  it("rapid quantity changes: intermediate requests are debounced and previous preview cleared immediately", async () => {
    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Rapidly step down Dal twice before timer fires
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    // Dismiss reason modal
    (findNode((p) => p.label === words.reasonCancel)?.props.onPress as () => void)();

    // Step down again immediately
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    // Select reason for Dal
    selectReason("Out of stock");

    // Fire timer
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Only one preview call was dispatched with the final count (0), not intermediate (1)
    expect(mock.previewCalls).toHaveLength(1);
    expect(mock.previewCalls[0]).toEqual([
      { listingId: dalListingId, count: 0, reason: "out_of_stock" },
    ]);
  });

  it("reason changes: changing a reason immediately clears preview and invalidates in-flight response", async () => {
    const d1 = deferred<{ ok: boolean; data: PartialAcceptPreviewResponse }>();
    const d2 = deferred<{ ok: boolean; data: PartialAcceptPreviewResponse }>();

    mock.customPreview = (lines: unknown) => {
      const arr = lines as Array<{ listingId: string; reason: string }>;
      const dal = arr.find((l) => l.listingId === dalListingId);
      if (dal?.reason === "out_of_stock") return d1.promise;
      if (dal?.reason === "damaged") return d2.promise;
      return Promise.resolve({
        ok: true,
        data: {
          productValue: "150.00",
          deliveryFee: "30.00",
          smallCartFee: null,
          total: "180.00",
          originalTotal: "230.00",
        },
      });
    };

    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Step down Dal: 2 -> 1
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");

    // Advance timer so preview request 1 (reason "out_of_stock") is fired
    render();
    vi.advanceTimersByTime(300);

    // Now change reason: open reason sheet and choose "Damaged"
    const chip = findNode((p) => p.accessibilityLabel === "Out of stock");
    (chip?.props.onPress as () => void)();
    selectReason("Damaged");

    // Immediately after changing reason, previous preview is cleared and send is disabled
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);

    // Advance timer so preview request 2 (reason "damaged") is fired
    render();
    vi.advanceTimersByTime(300);

    // Request 1 resolves with old reason
    d1.resolve({
      ok: true,
      data: {
        productValue: "150.00",
        deliveryFee: "30.00",
        smallCartFee: null,
        pickupFee: null,
        total: "180.00",
        originalTotal: "230.00",
        cancelsOrder: false,
        belowFloor: false,
        shopDiscount: null,
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Send should STILL be disabled because request 1 does not match current proposal reason
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);

    // Request 2 resolves with new reason
    d2.resolve({
      ok: true,
      data: {
        productValue: "150.00",
        deliveryFee: "30.00",
        smallCartFee: null,
        pickupFee: null,
        total: "180.00",
        originalTotal: "230.00",
        cancelsOrder: false,
        belowFloor: false,
        shopDiscount: null,
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Now send is enabled and submits with "damaged"
    const sendBtn = findNode((p) => p.label === words.sendNewTotal);
    expect(sendBtn?.props.disabled).toBe(false);
    await (sendBtn?.props.onPress as () => Promise<void>)();

    expect(mock.partialAcceptCalls[0]).toEqual([
      { listingId: dalListingId, count: 1, reason: "damaged" },
    ]);
  });

  it("cancellation and reopening edit mode: in-flight preview from cancelled session never populates reopened edit session", async () => {
    const d1 = deferred<{ ok: boolean; data: PartialAcceptPreviewResponse }>();

    mock.customPreview = () => d1.promise;

    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Step down Dal: 2 -> 1
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");

    // Advance timer to trigger preview request
    render();
    vi.advanceTimersByTime(300);

    // Cancel changes
    const cancelChangesBtn = findNode((p) => p.label === words.cancelChanges);
    (cancelChangesBtn?.props.onPress as () => void)();

    // Reopen edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Now resolve the in-flight preview request from the cancelled session
    d1.resolve({
      ok: true,
      data: {
        productValue: "150.00",
        deliveryFee: "30.00",
        smallCartFee: null,
        pickupFee: null,
        total: "180.00",
        originalTotal: "230.00",
        cancelsOrder: false,
        belowFloor: false,
        shopDiscount: null,
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // The reopened edit session must remain unedited with send disabled and no stale total
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);
    expect(allTexts()).not.toContain("₹180");
  });

  it("quantity display: edit mode clearly distinguishes original quantities from proposed quantities, including part-of-pack lines", () => {
    // Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // Before reductions:
    // Dal original: "Tata · 2 × 1 kg"
    // Oil original: "Fortune · 500 ml of a 1 L pack"
    expect(allTexts()).toContain("Tata · 2 × 1 kg");
    expect(allTexts()).toContain("Fortune · 500 ml of a 1 L pack");

    // Reduce Dal from 2 to 1
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    // Dismiss reason sheet
    (findNode((p) => p.label === words.reasonCancel)?.props.onPress as () => void)();

    // Both original ("Tata · 2 × 1 kg") and proposed ("Tata · 1 × 1 kg") must be visible
    let texts = allTexts();
    expect(texts).toContain("Tata · 2 × 1 kg");
    expect(texts).toContain("Tata · 1 × 1 kg");

    // Reduce Dal to 0
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    texts = allTexts();
    expect(texts).toContain("Tata · 2 × 1 kg");
    expect(texts).toContain("Tata · 0 × 1 kg");

    // Remove Mustard Oil (part of pack line)
    const removeBtns = findNodes((p) => p.label === words.removeLine);
    (removeBtns[removeBtns.length - 1]?.props.onPress as () => void)();

    // For part-of-pack line: original "Fortune · 500 ml of a 1 L pack" and proposed "Fortune · 0 × 1 L"
    texts = allTexts();
    expect(texts).toContain("Fortune · 500 ml of a 1 L pack");
    expect(texts).toContain("Fortune · 0 × 1 L");
  });

  it("polling: a new order object with the same lines does not refetch the preview or disable Send (#589)", async () => {
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();
    expect(mock.previewCalls).toHaveLength(1);

    // A poll lands: same lines, new object.
    mock.view = { ...(mock.view as object), order: { ...placedOrder, lines: placedOrder.lines.map((l) => ({ ...l })) } };
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mock.previewCalls).toHaveLength(1);
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(false);
  });

  it("a failed preview says so and keeps Send disabled (#589)", async () => {
    mock.customPreview = () => Promise.resolve({ ok: false, status: 500, code: "INTERNAL" });
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(allTexts()).toContain(words.previewFailed);
    expect(findNode((p) => p.label === words.sendNewTotal)?.props.disabled).toBe(true);
  });

  it("leaves edit mode when the order was answered while Send was in flight (#589)", async () => {
    const submission = deferred<boolean>();
    mock.customPartialAccept = () => submission.promise;
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();
    const sending = (findNode((p) => p.label === words.sendNewTotal)?.props.onPress as () => Promise<void>)();
    render();
    // The screen reads the order again while the request is open, and it was cancelled.
    mock.view = { ...(mock.view as object), order: { ...placedOrder, status: "cancelled_by_customer" } };
    render();
    submission.resolve(false);
    await sending;
    render();
    expect(findNode((p) => p.label === words.cancelChanges)).toBeUndefined();
  });

  it("pending submission: disables steppers, buttons and reason chips, and prevents mutations or multiple submissions", async () => {
    const submission = deferred<boolean>();
    mock.customPartialAccept = () => submission.promise;

    // 1. Enter edit mode
    (findNode((p) => p.label === words.acceptInPart)?.props.onPress as () => void)();

    // 2. Reduce Dal from 2 to 1 and choose reason
    (findNodes((p) => p.accessibilityLabel === words.reduceCount)[0]?.props.onPress as () => void)();
    selectReason("Out of stock");

    // 3. Debounce and resolve preview
    render();
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // Verify ready to send
    const sendBtn = findNode((p) => p.label === words.sendNewTotal);
    expect(sendBtn?.props.disabled).toBe(false);

    // 4. Tap "Send new total to customer" (triggers pending submission)
    const sendPromise = (sendBtn?.props.onPress as () => Promise<void>)();
    render();

    // Verify UI state while submitting === true
    const submittingSendBtn = findNode((p) => p.label === words.sendingNewTotal);
    expect(submittingSendBtn).toBeDefined();
    expect(submittingSendBtn?.props.busy).toBe(true);
    expect(submittingSendBtn?.props.disabled).toBe(true);

    const cancelBtn = findNode((p) => p.label === words.cancelChanges);
    expect(cancelBtn?.props.disabled).toBe(true);

    // All steppers disabled
    const minusBtns = findNodes((p) => p.accessibilityLabel === words.reduceCount);
    for (const btn of minusBtns) {
      expect(btn.props.disabled).toBe(true);
    }
    const plusBtns = findNodes((p) => p.accessibilityLabel === words.increaseCount);
    for (const btn of plusBtns) {
      expect(btn.props.disabled).toBe(true);
    }

    // Remove & undo buttons disabled
    const removeBtns = findNodes((p) => p.label === words.removeLine);
    for (const btn of removeBtns) {
      expect(btn.props.disabled).toBe(true);
    }
    const undoBtns = findNodes((p) => p.label === words.undoLine);
    for (const btn of undoBtns) {
      expect(btn.props.disabled).toBe(true);
    }

    // Reason chip disabled
    const reasonChip = findNode((p) => p.accessibilityLabel === "Out of stock");
    expect(reasonChip?.props.disabled).toBe(true);

    // 5. Attempt mutations while submission is pending
    // Try stepper down on Dal
    (minusBtns[0]?.props.onPress as () => void)();
    // Try stepper up on Dal
    (plusBtns[0]?.props.onPress as () => void)();
    // Try remove on Mustard Oil
    (removeBtns[removeBtns.length - 1]?.props.onPress as () => void)();
    // Try undo on Dal
    (undoBtns[0]?.props.onPress as () => void)();
    // Try pressing reason chip
    (reasonChip?.props.onPress as () => void)();
    // Try cancel editing
    (cancelBtn?.props.onPress as () => void)();
    // Try double-tapping submit
    (submittingSendBtn?.props.onPress as () => void)();

    render();

    // Verify quantities and reasons remain unchanged:
    // Dal is still 1 × 1 kg (not 0, not 2)
    const texts = allTexts();
    expect(texts).toContain("Tata · 1 × 1 kg");
    // Reason sheet did NOT open
    expect(findNode((p) => p.children === words.reasonSheetTitle)).toBeUndefined();
    // Submission was NOT called a second time
    expect(mock.partialAcceptCalls).toHaveLength(1);

    // 6. Resolve submission
    submission.resolve(true);
    await sendPromise;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();

    // After success: edit mode exited, regular buttons restored
    expect(findNode((p) => p.label === words.sendNewTotal)).toBeUndefined();
    expect(findNode((p) => p.label === words.accept)).toBeDefined();
  });
});

describe("Waiting state and countdown on S05 and S04 (#527)", () => {
  const confirmByAt = "2030-01-01T00:05:00.000Z";

  const awaitingOrder: ShopOrderResponse = {
    ...placedOrder,
    status: "awaiting_customer_confirm",
    confirmByAt,
    proposal: {
      id: "00000000-0000-4000-8000-000000000010",
      revision: 2,
      sourceStatus: "placed",
      createdAt: "2030-01-01T00:02:00.000Z",
      confirmByAt,
      productValue: "100.00",
      originalProductValue: "200.00",
      deliveryFee: "30.00",
      smallCartFee: null,
      pickupFee: null,
      total: "130.00",
      originalTotal: "230.00",
      shopDiscount: null,
      lostShopDiscount: null,
      lines: [
        {
          listingId: dalListingId,
          name: "Toor Dal",
          brand: "Tata",
          baseUnit: "kg",
          quantity: "1",
          originalCount: 2,
          count: 1,
          originalPart: null,
          part: null,
          unitPrice: "100.00",
          originalLineTotal: "200.00",
          lineTotal: "100.00",
          changeReason: "out_of_stock",
        },
        {
          listingId: oilListingId,
          name: "Mustard Oil",
          brand: "Fortune",
          baseUnit: "l",
          quantity: "1",
          originalCount: 1,
          count: 1,
          originalPart: "0.500",
          part: "0.500",
          unitPrice: "30.00",
          originalLineTotal: "30.00",
          lineTotal: "30.00",
          changeReason: null,
        },
      ],
    },
  };

  beforeEach(() => {
    mock.hooks = [];
    mock.effects = [];
    mock.ordersViewActive = false;
    mock.view = {
      status: "ready",
      order: awaitingOrder,
      offset: 0,
      expired: false,
      message: null,
      refreshing: false,
      notice: null,
      shortLines: [],
      answering: null,
    };
  });

  it("S05: shows waiting banner and countdown for confirmByAt, proposal values, and locks editing", () => {
    const texts = allTexts();

    // Shows waiting banner
    expect(texts).toContain(words.waitingForConfirm);

    // Proposal values displayed
    expect(texts).toContain("₹230"); // original struck-through total
    expect(texts).toContain("₹130"); // new proposed total
    expect(texts).toContain("Out of stock"); // line change reason

    // Countdown rendered for confirmByAt
    const countdown = findNode((p) => typeof p.seconds === "number");
    expect(countdown).toBeDefined();

    // Editing is locked: no Accept, Reject, or Accept in part buttons
    const buttons = findNodes((p) => typeof p.label === "string");
    const labels = buttons.map((b) => b.props.label);
    expect(labels).not.toContain(words.accept);
    expect(labels).not.toContain(words.acceptInPart);
    expect(labels).not.toContain(words.reject);
  });

  it("S04: accepted-group rows in awaiting_customer_confirm show ExpiryCountdown with server offset", () => {
    mock.ordersViewActive = true;
    mock.ordersView = {
      status: "ready",
      refreshing: false,
      message: null,
      offset: 4000,
      orders: {
        canDeliver: true,
        new: [],
        accepted: [
          {
            id: "order-1",
            number: 101,
            status: "awaiting_customer_confirm",
            placedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: null,
            confirmByAt,
            itemCount: 2,
            total: "130.00",
            address: { flat: "402", areaLine: "MG Road" },
            cancelAsked: false,
          },
        ],
        doneToday: [],
        myDeliveries: [],
      },
    };

    mock.cursor = 0;
    const tree = OrdersScreen();
    const nodes = elements(tree);

    // Find ExpiryCountdown node
    const expiryCountdown = nodes.find((n) => n.type === "ExpiryCountdown");
    expect(expiryCountdown).toBeDefined();
    expect(expiryCountdown?.props.expiresAt).toBe(confirmByAt);
    expect(expiryCountdown?.props.offset).toBe(4000); // Uses server's now offset
  });
});
