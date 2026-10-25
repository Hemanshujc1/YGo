import { randomUUID } from "node:crypto";
import { Account, Session } from "@ygo/contracts";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalIdentityVerifier, type IdentityVerifier } from "../src/adapters/identity-verifier";
import { createLocalMailer } from "../src/adapters/mailer";
import { connectDatabase } from "../src/db";

const database = connectDatabase(inject("databaseUrl"));
const active: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map((app) => app.close())); });
afterAll(() => database.close());

function harness(override?: IdentityVerifier) {
  const verifier = createLocalIdentityVerifier();
  const clock = createLocalClock(new Date("2030-01-01T00:00:00Z"));
  const mailer = createLocalMailer();
  const app = buildApp({ database, checkDatabase: database.ping, clock, mailer,
    identityVerifier: override ?? verifier, authTokenSecret: "01234567890123456789012345678901" });
  active.push(app);
  const address = `2001:db8:${randomUUID().slice(0, 4)}::1`;
  const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/v1/auth/${path}`, payload, headers: { "x-forwarded-for": address } });
  const challenge = async (provider = "google") => (await post("identity/challenge", { provider })).json<{ nonce: string }>().nonce;
  return { app, verifier, clock, mailer, post, challenge };
}

describe("ACC-1 provider sign-in", () => {
  it("reuses one account across email, Google and Apple and issues ordinary revocable sessions", async () => {
    const h = harness();
    const email = `${randomUUID()}@example.com`;
    await h.post("code", { email });
    const code = h.mailer.sent[0]?.text.match(/code is (\d{6})/)?.[1];
    const original = Session.parse((await h.post("verify", { email, code })).json());
    for (const provider of ["google", "apple"] as const) {
      const nonce = await h.challenge(provider);
      const identityToken = h.verifier.mint(provider, email.toUpperCase(), nonce);
      const response = await h.post("identity", { provider, identityToken, nonce });
      expect(response.statusCode).toBe(200);
      const session = Session.parse(response.json());
      expect(session.account).toEqual(original.account);
      const refreshed = await h.post("refresh", { refreshToken: session.refreshToken });
      expect(refreshed.statusCode).toBe(200);
      const access = Session.parse(refreshed.json()).accessToken;
      expect(Account.parse((await h.app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${access}` } })).json()).id).toBe(original.account.id);
      expect((await h.app.inject({ method: "POST", url: "/v1/auth/sign-out", headers: { authorization: `Bearer ${access}` } })).statusCode).toBe(204);
      expect((await h.post("refresh", { refreshToken: Session.parse(refreshed.json()).refreshToken })).statusCode).toBe(401);
    }
  });

  it("leaves new accounts needing a profile, and keeps Apple's relay address separate", async () => {
    const h = harness();
    const ids = [];
    for (const email of [`${randomUUID()}@example.com`, `${randomUUID()}@privaterelay.appleid.com`]) {
      const nonce = await h.challenge("apple");
      const response = await h.post("identity", { provider: "apple", nonce, identityToken: h.verifier.mint("apple", email, nonce) });
      const session = Session.parse(response.json());
      expect(session.account).toMatchObject({ email, name: null, phone: null });
      ids.push(session.account.id);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("requires mailbox verification without creating an account or a session", async () => {
    const h = harness();
    const email = `${randomUUID()}@example.com`;
    const nonce = await h.challenge();
    const response = await h.post("identity", { provider: "google", nonce, identityToken: h.verifier.mint("google", email, nonce, true) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ emailVerificationRequired: email });
    expect((await database.pool.query("SELECT id FROM accounts WHERE email = $1", [email])).rowCount).toBe(0);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("refuses invented, wrong-provider, wrong-nonce, expired and replayed attempts", async () => {
    const h = harness();
    const email = `${randomUUID()}@example.com`;
    for (const invalid of ["invented", "provider", "nonce"]) {
      const nonce = await h.challenge();
      const identityToken = invalid === "invented" ? "forged" : h.verifier.mint(invalid === "provider" ? "apple" : "google", email, invalid === "nonce" ? "other" : nonce);
      expect((await h.post("identity", { provider: "google", nonce, identityToken })).statusCode).toBe(401);
    }
    const nonce = await h.challenge();
    const payload = { provider: "google", nonce, identityToken: h.verifier.mint("google", email, nonce) };
    const answers = await Promise.all([h.post("identity", payload), h.post("identity", payload)]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 401]);
    const expired = await h.challenge();
    h.clock.advance(300_000);
    expect((await h.post("identity", { provider: "google", nonce: expired, identityToken: h.verifier.mint("google", email, expired) })).statusCode).toBe(401);
  });

  it("bounds challenges per network address and allows a fresh window", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) expect((await h.post("identity/challenge", { provider: "google" })).statusCode).toBe(200);
    expect((await h.post("identity/challenge", { provider: "apple" })).statusCode).toBe(429);
    h.clock.advance(300_000);
    expect((await h.post("identity/challenge", { provider: "apple" })).statusCode).toBe(200);
  });

  it("refuses client-supplied emails and malformed or oversized identity requests", async () => {
    const h = harness();
    const nonce = await h.challenge();
    for (const payload of [
      { provider: "google", nonce, identityToken: "token", email: "attacker@example.com" },
      { provider: "other", nonce, identityToken: "token" },
      { provider: "google", nonce: "short", identityToken: "token" },
      { provider: "google", nonce, identityToken: "x".repeat(8193) },
    ]) expect((await h.post("identity", payload)).statusCode).toBe(400);
  });

  it("answers unavailable when provider keys cannot be reached, without exposing the token", async () => {
    const h = harness({ verify: async () => { throw new Error("provider unavailable"); } });
    const nonce = await h.challenge();
    const response = await h.post("identity", { provider: "google", nonce, identityToken: "private-token" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private-token");
  });
});
