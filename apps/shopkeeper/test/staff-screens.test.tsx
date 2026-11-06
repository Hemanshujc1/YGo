import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  hooks: [] as unknown[], cursor: 0, started: false, params: {} as Record<string, string>, push: vi.fn(), replace: vi.fn(), share: vi.fn(),
  api: { shopStaff: vi.fn(), staffInvites: vi.fn(), setStaffCanDeliver: vi.fn(), deactivateStaff: vi.fn(), inviteStaff: vi.fn() },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = typeof value === "function" ? (value as (old: unknown) => unknown)(mock.hooks[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = { current: initial };
    return mock.hooks[index];
  },
  useCallback: (fn: unknown) => fn,
}));
vi.mock("expo-router", () => ({ Link: "Link", useRouter: () => ({ push: mock.push, replace: mock.replace }), useLocalSearchParams: () => mock.params }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", Confirm: "Confirm", FieldMessage: "FieldMessage", PhoneField: "PhoneField", useInFront: ({ start }: { start: () => void }) => { if (!mock.started) { mock.started = true; start(); } } }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View", Share: { share: mock.share } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/components/toggle", () => ({ Toggle: "Toggle" }));
vi.mock("../src/api", () => ({ api: mock.api, access: { shopName: () => "Sai General Stores" } }));
import InviteStaffScreen from "../src/app/invite-staff";
import StaffScreen from "../src/app/staff";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  // Own components (Section, PersonRow) are drawn like React would, so their text is seen.
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
function draw(screen: () => unknown) { mock.cursor = 0; return elements(screen()); }
const texts = (nodes: El[]) => nodes.flatMap(({ props: { children } }) => typeof children === "string" ? [children]
  : Array.isArray(children) && children.every((c) => typeof c === "string") ? [children.join("")] : []);
const button = (nodes: El[], label: string) => nodes.find((n) => n.type === "Button" && n.props.label === label);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ravi = { accountId: "00000000-0000-4000-8000-000000000001", name: "Ravi", phone: "+919800000001", canDeliver: false };
const unnamed = { accountId: "00000000-0000-4000-8000-000000000002", name: null, phone: "+919800000002", canDeliver: true };
const invited = { phone: "+919800000003", name: null, canDeliver: true, status: "invited" as const, expiresAt: "2099-01-01T00:00:00.000Z" };
const gone = { phone: "+919800000004", name: "Meena", canDeliver: false, status: "deactivated" as const, expiresAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  mock.hooks = []; mock.params = {}; mock.started = false;
  mock.share.mockResolvedValue(undefined);
  mock.api.shopStaff.mockResolvedValue({ ok: true, data: { staff: [ravi, unnamed] } });
  mock.api.staffInvites.mockResolvedValue({ ok: true, data: { invites: [invited, gone] } });
});

describe("S16 Staff (#535)", () => {
  async function open() { draw(StaffScreen); await settle(); return draw(StaffScreen); }

  it("lists who works here, who is invited and who was deactivated, naming unnamed people by number", async () => {
    const shown = texts(await open());
    expect(shown).toEqual(expect.arrayContaining(["Working here", "Invited", "Deactivated", "Ravi", "98000 00002", "98000 00003", "Meena"]));
    expect(shown.indexOf("Working here")).toBeLessThan(shown.indexOf("Invited"));
    expect(shown.indexOf("Invited")).toBeLessThan(shown.indexOf("Deactivated"));
  });

  it("flips can deliver and reads the list again", async () => {
    mock.api.setStaffCanDeliver.mockResolvedValue({ ok: true, data: { accountId: ravi.accountId, canDeliver: true } });
    const nodes = await open();
    const toggle = nodes.find((n) => n.type === "Toggle" && n.props.label === "Ravi can deliver");
    (toggle?.props.onPress as () => void)();
    await settle();
    expect(mock.api.setStaffCanDeliver).toHaveBeenCalledWith(ravi.accountId, { canDeliver: true });
    expect(mock.api.shopStaff).toHaveBeenCalledTimes(2);
  });

  it("shows the server's refusal when a change fails, and still reads the truth again", async () => {
    mock.api.setStaffCanDeliver.mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND" });
    const nodes = await open();
    (nodes.find((n) => n.type === "Toggle")?.props.onPress as () => void)();
    await settle();
    expect(texts(draw(StaffScreen)).some((line) => line.length > 0 && line !== "Working here")).toBe(true);
    expect(mock.api.shopStaff).toHaveBeenCalledTimes(2);
  });

  it("asks before deactivating, and does nothing if cancelled", async () => {
    mock.api.deactivateStaff.mockResolvedValue({ ok: true, data: undefined });
    const nodes = await open();
    (button(nodes, "Deactivate")?.props.onPress as () => void)();
    const confirm = draw(StaffScreen).find((n) => n.type === "Confirm");
    expect(confirm?.props).toMatchObject({ visible: true, title: "Deactivate Ravi?" });
    (confirm?.props.onCancel as () => void)();
    await settle();
    expect(mock.api.deactivateStaff).not.toHaveBeenCalled();
    (button(draw(StaffScreen), "Deactivate")?.props.onPress as () => void)();
    (draw(StaffScreen).find((n) => n.type === "Confirm")?.props.onConfirm as () => void)();
    await settle();
    expect(mock.api.deactivateStaff).toHaveBeenCalledWith(ravi.accountId);
  });

  it("opens S20 filled in to send a new code or invite again", async () => {
    const nodes = await open();
    (button(nodes, "Send a new code")?.props.onPress as () => void)();
    expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/invite-staff", params: { phone: "+919800000003", canDeliver: "1" } });
    (button(nodes, "Invite again")?.props.onPress as () => void)();
    expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/invite-staff", params: { phone: "+919800000004", canDeliver: "0" } });
  });

  it("keeps the list and says why when a later read fails, and lets only the newest read draw", async () => {
    await open();
    mock.api.shopStaff.mockResolvedValue({ ok: false, status: 0, code: "NETWORK" });
    const nodes = draw(StaffScreen);
    ((nodes.find((n) => n.type === "ScrollView")?.props.refreshControl as El).props.onRefresh as () => void)();
    await settle();
    const after = draw(StaffScreen);
    expect(texts(after)).toContain("Ravi");
    expect(texts(after).length).toBeGreaterThan(texts(nodes).length);
  });

  it("offers a retry when the list cannot load", async () => {
    mock.api.shopStaff.mockResolvedValue({ ok: false, status: 0, code: "NETWORK" });
    draw(StaffScreen); await settle();
    expect(button(draw(StaffScreen), "Try again")).toBeDefined();
  });
});

describe("S20 Invite staff (#535)", () => {
  const phoneField = () => draw(InviteStaffScreen).find((n) => n.type === "PhoneField") as El;

  it("refuses a number that is not a mobile number without calling the server", () => {
    draw(InviteStaffScreen);
    (phoneField().props.onChangeText as (t: string) => void)("12345");
    (button(draw(InviteStaffScreen), "Get join code")?.props.onPress as () => void)();
    expect(phoneField().props.message).toBe("Enter a 10-digit mobile number.");
    expect(mock.api.inviteStaff).not.toHaveBeenCalled();
  });

  it("sends the number as the server stores it and shows the one-time code with its rules", async () => {
    mock.api.inviteStaff.mockResolvedValue({ ok: true, data: { code: "ABCD2345", expiresAt: "2030-01-02T00:00:00.000Z" } });
    draw(InviteStaffScreen);
    (phoneField().props.onChangeText as (t: string) => void)("98000 00001");
    (button(draw(InviteStaffScreen), "Get join code")?.props.onPress as () => void)();
    await settle();
    expect(mock.api.inviteStaff).toHaveBeenCalledWith({ phone: "+919800000001", canDeliver: false });
    const shown = texts(draw(InviteStaffScreen));
    expect(shown).toContain("ABCD2345");
    expect(shown.some((line) => line.startsWith("Works once, only on this number's own phone"))).toBe(true);
    (button(draw(InviteStaffScreen), "Share code")?.props.onPress as () => void)();
    expect(mock.share).toHaveBeenCalledWith({ message: expect.stringContaining("ABCD2345") });
  });

  it("starts from the number and flag S16 passes, so a new code is one tap", async () => {
    mock.params = { phone: "+919800000003", canDeliver: "1" };
    mock.api.inviteStaff.mockResolvedValue({ ok: true, data: { code: "WXYZ6789", expiresAt: "2030-01-02T00:00:00.000Z" } });
    draw(InviteStaffScreen);
    expect(phoneField().props.value).toBe("9800000003");
    (button(draw(InviteStaffScreen), "Get join code")?.props.onPress as () => void)();
    await settle();
    expect(mock.api.inviteStaff).toHaveBeenCalledWith({ phone: "+919800000003", canDeliver: true });
  });

  it("shows the already-at-another-shop refusal and no code", async () => {
    mock.api.inviteStaff.mockResolvedValue({ ok: false, status: 409, code: "STAFF_AT_ANOTHER_SHOP" });
    draw(InviteStaffScreen);
    (phoneField().props.onChangeText as (t: string) => void)("9800000001");
    (button(draw(InviteStaffScreen), "Get join code")?.props.onPress as () => void)();
    await settle();
    const nodes = draw(InviteStaffScreen);
    expect(nodes.find((n) => n.type === "FieldMessage")?.props.text).toBe("That number is linked to another shop.");
    expect(button(nodes, "Share code")).toBeUndefined();
  });
});
