import { JOIN_CODE_ALPHABET } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { cleanCode, tryJoin } from "../src/join-shop-flow";

const refused = (code: string) => ({ ok: false as const, status: 400, code });

describe("S21 join code (#536)", () => {
  it("keeps only the server's alphabet, in capitals, at most one code long", () => {
    expect(cleanCode(" abcd-2345 ")).toBe("ABCD2345");
    expect(cleanCode("ABCD2345EXTRA")).toBe("ABCD2345");
    // I, O, 0 and 1 are never drawn, so they are never kept.
    expect(cleanCode("IO01")).toBe("");
    expect([...JOIN_CODE_ALPHABET]).toHaveLength(32);
    expect(cleanCode(JOIN_CODE_ALPHABET)).toBe(JOIN_CODE_ALPHABET.slice(0, 8));
  });

  it("does not ask the server about a short code", async () => {
    const join = vi.fn();
    expect(await tryJoin("ABC", join)).toEqual({ problem: "short" });
    expect(await tryJoin("", join)).toEqual({ problem: "short" });
    expect(join).not.toHaveBeenCalled();
  });

  it("returns the shop on success and sends the code once, in the server's shape", async () => {
    const join = vi.fn().mockResolvedValue({ ok: true, data: { shopName: "Sai General Stores" } });
    expect(await tryJoin("abcd2345", join)).toEqual({ shopName: "Sai General Stores" });
    expect(join).toHaveBeenCalledExactlyOnceWith({ code: "ABCD2345" });
  });

  it("maps each refusal to its own problem", async () => {
    const cases = { CODE_WRONG: "wrong", CODE_EXPIRED: "expired", CODE_LOCKED: "locked", ALREADY_LINKED: "linked", INTERNAL: "other" } as const;
    for (const [code, problem] of Object.entries(cases)) {
      expect(await tryJoin("ABCD2345", () => Promise.resolve(refused(code) as never))).toEqual({ problem });
    }
  });

  it("says offline when the server cannot be reached", async () => {
    expect(await tryJoin("ABCD2345", () => Promise.reject(new Error("down")))).toEqual({ problem: "offline" });
  });
});
