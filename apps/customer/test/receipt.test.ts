import type { ApiResult } from "@ygo/api-client";
import type { ReceiptResponse } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/share-receipt", () => ({ shareReceipt: async () => undefined }));
const { hasReceipt, makeReceipt } = await import("../src/lib/receipt");

const data = { number: 1 } as ReceiptResponse;
const client = (result: ApiResult<ReceiptResponse>) => ({ receipt: async () => result });

describe("receipt action on C19 (#61)", () => {
  it("is offered for delivered and picked-up orders only", () => {
    expect(hasReceipt("delivered")).toBe(true);
    expect(hasReceipt("picked_up")).toBe(true);
    for (const status of ["placed", "accepted", "arrived", "cancelled_by_customer", "rejected_by_shop", "expired", "delivery_failed"] as const) expect(hasReceipt(status)).toBe(false);
  });

  it("shares what the server returned", async () => {
    const share = vi.fn(async () => undefined);
    expect(await makeReceipt(client({ ok: true, data }), "o1", share)).toBe("shared");
    expect(share).toHaveBeenCalledWith(data);
  });

  it("fails without sharing when the server refuses or can't be reached", async () => {
    const share = vi.fn(async () => undefined);
    expect(await makeReceipt(client({ ok: false, status: 0, code: "UNAVAILABLE" }), "o1", share)).toBe("failed");
    expect(await makeReceipt(client({ ok: false, status: 409, code: "ORDER_STATUS_CHANGED" }), "o1", share)).toBe("failed");
    expect(share).not.toHaveBeenCalled();
  });

  it("fails, rather than throwing, when the request itself throws", async () => {
    const share = vi.fn(async () => undefined);
    expect(await makeReceipt({ receipt: async () => { throw new Error("Network request failed"); } }, "o1", share)).toBe("failed");
    expect(share).not.toHaveBeenCalled();
  });

  it("fails when the PDF or the share sheet throws", async () => {
    expect(await makeReceipt(client({ ok: true, data }), "o1", async () => { throw new Error("print failed"); })).toBe("failed");
  });
});
