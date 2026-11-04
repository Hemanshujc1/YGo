import type { ApiResult } from "@ygo/api-client";
import type { Notification, NotificationsResponse } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createNotifications, type NotificationsWords } from "../src/notifications";

const row = (n: number, read = false, orderId: string | null = null): Notification => ({
  id: `7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c${String(n).padStart(4, "0")}`, kind: "order_accepted", title: `Order #${1000 + n} accepted`,
  body: "Sai General Stores is getting your order ready.", orderId, createdAt: "2030-01-01T00:00:00.000Z", read,
});
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const done = ok(undefined);
const refused: ApiResult<undefined> = { ok: false, status: 503, code: "UNAVAILABLE" };
const words = { offline: "offline", errors: { UNAVAILABLE: "unavailable" }, readAllFailed: "not read" } as unknown as NotificationsWords;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeServer() {
  const reads: Array<(answer: ApiResult<NotificationsResponse>) => void> = [];
  const client = {
    notifications: vi.fn(() => new Promise<ApiResult<NotificationsResponse>>((resolve) => reads.push(resolve))),
    readNotification: vi.fn(async (): Promise<ApiResult<undefined>> => done),
    readAllNotifications: vi.fn(async (): Promise<ApiResult<undefined>> => done),
  };
  return { client, reads, answer: (data: NotificationsResponse) => reads.shift()?.(ok(data)) };
}

async function loaded(data: NotificationsResponse) {
  const server = fakeServer();
  const list = createNotifications(server.client, words);
  list.start();
  server.answer(data);
  await settle();
  return { server, list };
}

describe("C22 notifications (#506)", () => {
  it("loads, then shows the rows and lights the bell while any is unread", async () => {
    const server = fakeServer();
    const list = createNotifications(server.client, words);
    list.start();
    expect(list.get().status).toBe("loading");
    server.answer({ notifications: [row(2), row(1, true)], unread: true });
    await settle();
    expect(list.get()).toMatchObject({ status: "ready", unread: true });
    expect(list.get().notifications).toHaveLength(2);
  });

  it("shows the empty list with no dot", async () => {
    const { list } = await loaded({ notifications: [], unread: false });
    expect(list.get()).toMatchObject({ status: "ready", notifications: [], unread: false });
  });

  it("keeps the dot for an unread row beyond the 50 shown", async () => {
    const { list } = await loaded({ notifications: [row(1, true)], unread: true });
    expect(list.get().unread).toBe(true);
  });

  it("fails with the error's words, and Try again reads again", async () => {
    const server = fakeServer();
    const list = createNotifications(server.client, words);
    list.start();
    server.reads.shift()?.({ ok: false, status: 503, code: "UNAVAILABLE" });
    await settle();
    expect(list.get()).toMatchObject({ status: "failed", message: words.errors.UNAVAILABLE });
    void list.retry();
    server.answer({ notifications: [row(1)], unread: true });
    await settle();
    expect(list.get()).toMatchObject({ status: "ready", message: null });
  });

  it("reads a tapped row at once, and tells the server", async () => {
    const { list, server } = await loaded({ notifications: [row(2), row(1)], unread: true });
    list.read(row(2).id);
    expect(list.get().notifications?.map((r) => r.read)).toEqual([true, false]);
    expect(list.get().unread).toBe(true);
    list.read(row(1).id);
    expect(list.get().unread).toBe(false);
    expect(server.client.readNotification).toHaveBeenCalledWith(row(2).id);
  });

  it("keeps a tapped row read over an answer that left before the tap", async () => {
    const { list, server } = await loaded({ notifications: [row(1)], unread: true });
    void list.refresh();
    list.read(row(1).id);
    await settle();
    server.answer({ notifications: [row(1)], unread: true });
    await settle();
    expect(list.get()).toMatchObject({ unread: false, notifications: [{ read: true }] });
  });

  it("shows a row whose read the server refused as New again at the next read", async () => {
    const { list, server } = await loaded({ notifications: [row(1)], unread: true });
    server.client.readNotification.mockResolvedValueOnce(refused);
    list.read(row(1).id);
    expect(list.get().unread).toBe(false);
    await settle();
    void list.refresh();
    server.answer({ notifications: [row(1)], unread: true });
    await settle();
    expect(list.get()).toMatchObject({ unread: true, notifications: [{ read: false }] });
  });

  it("marks all read, and drops a read that was on its way", async () => {
    const { list, server } = await loaded({ notifications: [row(2), row(1)], unread: true });
    void list.refresh();
    await list.readAll();
    expect(server.client.readAllNotifications).toHaveBeenCalled();
    server.answer({ notifications: [row(2), row(1)], unread: true });
    await settle();
    expect(list.get()).toMatchObject({ unread: false, refreshing: false, message: null });
    expect(list.get().notifications?.every((r) => r.read)).toBe(true);
  });

  it("puts the rows back with a message when Mark all as read fails", async () => {
    const { list, server } = await loaded({ notifications: [row(2), row(1, true)], unread: true });
    server.client.readAllNotifications.mockResolvedValueOnce(refused);
    await list.readAll();
    expect(list.get()).toMatchObject({ unread: true, message: words.readAllFailed });
    expect(list.get().notifications?.map((r) => r.read)).toEqual([false, true]);
  });

  it("reads again for a push only while its screen is in front", async () => {
    const { list, server } = await loaded({ notifications: [], unread: false });
    list.pushed();
    expect(server.reads).toHaveLength(1);
    server.answer({ notifications: [row(1)], unread: true });
    await settle();
    expect(list.get().unread).toBe(true);
    list.stop();
    list.pushed();
    expect(server.reads).toHaveLength(0);
  });

  it("puts back only the rows it marked, on the newer list a push brought meanwhile", async () => {
    const { list, server } = await loaded({ notifications: [row(1)], unread: true });
    let refuse: (answer: ApiResult<undefined>) => void = () => {};
    server.client.readAllNotifications.mockReturnValueOnce(new Promise((resolve) => (refuse = resolve)));
    const marking = list.readAll();
    list.pushed();
    server.answer({ notifications: [row(2), row(1)], unread: true });
    await settle();
    refuse(refused);
    await marking;
    expect(list.get().notifications?.map((r) => [r.id, r.read])).toEqual([[row(2).id, false], [row(1).id, false]]);
  });

  it("asks the server again after the last shown unread row is read, for unread ones beyond the 50", async () => {
    const { list, server } = await loaded({ notifications: [row(1)], unread: true });
    list.read(row(1).id);
    expect(list.get().unread).toBe(false);
    await settle();
    server.answer({ notifications: [row(1, true)], unread: true });
    await settle();
    expect(list.get()).toMatchObject({ unread: true });
  });

  it("is shared by the bell and C22: a push reads while either is in front", async () => {
    const { list, server } = await loaded({ notifications: [], unread: false });
    list.start();
    list.stop();
    server.reads.length = 0;
    list.pushed();
    expect(server.reads).toHaveLength(1);
  });

  it("forgets the last account's rows on reset", async () => {
    const { list } = await loaded({ notifications: [row(1)], unread: true });
    list.reset();
    expect(list.get()).toMatchObject({ status: "loading", notifications: null, unread: false });
  });
});
