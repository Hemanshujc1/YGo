import { describe, expect, it, vi } from "vitest";
import { signInWithIdentity, type IdentityApi } from "../src/identity-flow";
const account = { id: "account", email: "asha@gmail.com", name: null, phone: null, theme: "system" as const };
const api = (): IdentityApi => ({
  identityChallenge: vi.fn(async () => ({ ok: true as const, data: { nonce: "challenge" } })),
  verifyIdentity: vi.fn(async () => ({ ok: true as const, data: account })),
});
describe("ACC-1 provider sign-in flow", () => {
  it("passes the server challenge to the native picker and verifies its token", async () => {
    const calls = api();
    const token = vi.fn(async () => "identity-token");
    expect(await signInWithIdentity(calls, "google", token)).toEqual({ signedIn: account });
    expect(token).toHaveBeenCalledWith("challenge");
    expect(calls.verifyIdentity).toHaveBeenCalledWith({ provider: "google", nonce: "challenge", identityToken: "identity-token" });
  });
  it("cancels quietly without creating a session", async () => {
    const calls = api();
    expect(await signInWithIdentity(calls, "apple", async () => null)).toEqual({ cancelled: true });
    expect(calls.verifyIdentity).not.toHaveBeenCalled();
  });
  it("returns the proven address to the email-code flow", async () => {
    const calls = api();
    calls.verifyIdentity = async () => ({ ok: true as const, data: { emailVerificationRequired: "asha@example.com" } });
    expect(await signInWithIdentity(calls, "google", async () => "token")).toEqual({ email: "asha@example.com" });
  });
  it("distinguishes provider failures, offline calls, refused tokens and storage failures", async () => {
    const calls = api();
    expect(await signInWithIdentity(calls, "google", async () => { throw new Error(); })).toEqual({ problem: "provider" });
    calls.verifyIdentity = async () => ({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(await signInWithIdentity(calls, "google", async () => "token")).toEqual({ problem: "UNAUTHENTICATED" });
    calls.verifyIdentity = async () => { throw new Error("keychain"); };
    expect(await signInWithIdentity(calls, "google", async () => "token")).toEqual({ problem: "not-saved" });
    calls.identityChallenge = async () => { throw new TypeError("offline"); };
    expect(await signInWithIdentity(calls, "google", async () => "token")).toEqual({ problem: "offline" });
  });
});
