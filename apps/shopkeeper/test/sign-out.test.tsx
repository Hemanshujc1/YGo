import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  state: [] as unknown[], cursor: 0, working: { current: false },
  identity: { status: "signed-in", account: { id: "account-1" } },
  epoch: 0, count: vi.fn(), signOut: vi.fn(), verify: vi.fn(), accessView: {} as { shopId?: string | null; mode: string; accountId?: string },
}));
vi.mock("react", () => ({
  useRef: () => mock.working,
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.state)) mock.state[index] = initial;
    return [mock.state[index], (value: unknown) => { mock.state[index] = value; }];
  },
}));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Confirm: "Confirm", Text: "Text" }));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("../src/api", () => ({ accountEpoch: () => mock.epoch, access: { verify: mock.verify, get: () => mock.accessView }, session: { get: () => mock.identity, signOut: mock.signOut } }));
vi.mock("../src/lib/opening-stock-database", () => ({ openingStockBeforeSignOut: mock.count }));

import { SignOut } from "../src/components/sign-out";

function render() {
  mock.cursor = 0;
  return SignOut({});
}

async function pressSignOut() {
  const view = render();
  view.props.children[0].props.onPress();
  // The native persistence check runs before the sign-out promise settles.
  await vi.waitFor(() => expect(mock.working.current).toBe(false));
  return render();
}

describe("opening-stock sign-out guard", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.epoch = 0; mock.state = []; mock.working.current = false;
    mock.identity = { status: "signed-in", account: { id: "account-1" } };
    mock.accessView = { shopId: "shop-1", mode: "offline" };
    mock.verify.mockResolvedValue({ shopId: "shop-1", state: "live" });
    mock.count.mockResolvedValue({ pending: 0, failed: 0 }); mock.signOut.mockResolvedValue(true);
  });

  it("blocks sign-out with the pending count and a stock retry link", async () => {
    mock.count.mockResolvedValue({ pending: 2, failed: 0 });
    const view = await pressSignOut();
    expect(mock.count).toHaveBeenCalledWith("account-1", "shop-1");
    expect(mock.verify).toHaveBeenCalledOnce();
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(view.props.children[1].props.children).toContain("2 stock entries");
    expect(view.props.children[2].props.href).toBe("/opening-stock");
  });

  it("keeps the session when saved stock cannot be checked", async () => {
    mock.count.mockRejectedValue(new Error("key unavailable"));
    const view = await pressSignOut();
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(view.props.children[1].props.children).toContain("Couldn't check");
  });

  it("does not show an old storage error after the account changes", async () => {
    mock.count.mockImplementation(async () => {
      mock.identity = { status: "signed-in", account: { id: "account-2" } };
      throw new Error("old account storage");
    });
    const view = await pressSignOut();
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(view.props.children[1]).toBeNull();
  });

  it("ignores a storage check from an earlier login of the same account", async () => {
    mock.count.mockImplementation(async () => { mock.epoch++; return { pending: 0, failed: 0 }; });
    await pressSignOut(); expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("warns before signing out with acknowledged failures, then checks pending work again", async () => {
    mock.count.mockResolvedValue({ pending: 0, failed: 2 });
    const view = await pressSignOut();
    expect(mock.signOut).not.toHaveBeenCalled();
    const confirmation = view.props.children[3];
    expect(confirmation.props.visible).toBe(true);
    expect(confirmation.props.body).toContain("stay encrypted");
    confirmation.props.onConfirm();
    await vi.waitFor(() => expect(mock.signOut).toHaveBeenCalledOnce());
    expect(mock.count).toHaveBeenCalledTimes(2);
  });

  it("does not apply another account's failure-warning confirmation", async () => {
    mock.count.mockResolvedValue({ pending: 0, failed: 1 });
    const view = await pressSignOut();
    mock.identity = { status: "signed-in", account: { id: "account-2" } };
    view.props.children[3].props.onConfirm();
    await vi.waitFor(() => expect(mock.working.current).toBe(false));
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("does not reuse a failure warning from an earlier login of the same account", async () => {
    mock.count.mockResolvedValue({ pending: 0, failed: 1 }); const view = await pressSignOut();
    mock.epoch++; view.props.children[3].props.onConfirm();
    await vi.waitFor(() => expect(mock.working.current).toBe(false)); expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("signs out after the queue is confirmed empty", async () => {
    await pressSignOut();
    expect(mock.signOut).toHaveBeenCalledOnce();
  });

  it("uses a confirmed unlinked result to safely include legacy records in the same guard", async () => {
    mock.verify.mockResolvedValue({ shopId: null, state: null });
    mock.accessView = { mode: "online", accountId: "account-1" };
    await pressSignOut();
    expect(mock.count).toHaveBeenCalledWith("account-1", null);
    expect(mock.signOut).toHaveBeenCalledOnce();
  });

  it("accepts a refreshed session object for the same account", async () => {
    mock.count.mockImplementation(async () => {
      mock.identity = { status: "signed-in", account: { id: "account-1" } };
      return { pending: 0, failed: 0 };
    });
    await pressSignOut();
    expect(mock.signOut).toHaveBeenCalledOnce();
  });

  it("does not sign out an account that changed during the storage check", async () => {
    mock.count.mockImplementation(async () => {
      mock.identity = { status: "signed-in", account: { id: "account-2" } };
      return { pending: 0, failed: 0 };
    });
    await pressSignOut();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

it("blocks sign-out for pending manual flags and links to Stock", async () => {
  mock.count.mockResolvedValue({ pending: 2, failed: 0, stockPending: 2 });
  const view = await pressSignOut();
  expect(mock.signOut).not.toHaveBeenCalled();
  expect(view.props.children[2].props.href).toBe("/stock");
});

});
