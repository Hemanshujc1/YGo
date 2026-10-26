import { randomUUID } from "node:crypto";
import { Session } from "@ygo/contracts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, describe, expect, inject, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { createLocalClock } from "../src/adapters/clock";
import { createIdentityVerifier } from "../src/adapters/identity-verifier";
import { createLocalMailer } from "../src/adapters/mailer";
import { connectDatabase } from "../src/db";

const database = connectDatabase(inject("databaseUrl"));
let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => { await app?.close(); vi.unstubAllGlobals(); });
afterAll(() => database.close());

describe("ACC-1 signed identity through the public API", () => {
  it("checks signatures, issuer, audience, lifetime, email proof and nonce without a real provider", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256", use: "sig" };
    const fetchKeys = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchKeys);
    const clock = createLocalClock(new Date());
    app = buildApp({ database, checkDatabase: database.ping, clock, mailer: createLocalMailer(),
      identityVerifier: createIdentityVerifier({ google: ["ygo-google"], apple: ["ygo-apple"] }, clock),
      authTokenSecret: "01234567890123456789012345678901" });
    const server = app;
    const email = `${randomUUID()}@gmail.com`;
    async function signIn(provider: "google" | "apple", claims = {}, key = privateKey) {
      const challenge = await server.inject({ method: "POST", url: "/v1/auth/identity/challenge", payload: { provider } });
      const { nonce } = challenge.json<{ nonce: string }>();
      const now = Math.floor(clock.now().getTime() / 1000);
      const identityToken = await new SignJWT({ sub: "provider-user", email, email_verified: true, nonce,
        iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
        aud: provider === "google" ? "ygo-google" : "ygo-apple", iat: now, exp: now + 300, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(key);
      return server.inject({ method: "POST", url: "/v1/auth/identity", payload: { provider, nonce, identityToken } });
    }
    const first = await signIn("google");
    expect(first.statusCode).toBe(200);
    expect(Session.parse(first.json()).account.email).toBe(email);
    for (const claims of [{ nonce: "wrong" }, { email_verified: false }, { email: "invalid" },
      { iss: "attacker" }, { aud: "other-app" }, { exp: 1 }, { iat: Math.floor(clock.now().getTime() / 1000) - 301 }, { sub: "" }]) {
      expect((await signIn("google", claims)).statusCode).toBe(401);
    }
    const other = await generateKeyPair("RS256");
    expect((await signIn("google", {}, other.privateKey)).statusCode).toBe(401);
    const external = `${randomUUID()}@example.com`;
    expect((await signIn("google", { email: external })).json()).toEqual({ emailVerificationRequired: external });
    expect(Session.parse((await signIn("google", { email: external, hd: "example.com" })).json()).account.email).toBe(external);
    const relay = `${randomUUID()}@privaterelay.appleid.com`;
    expect(Session.parse((await signIn("apple", { email: relay, email_verified: "true" })).json()).account.email).toBe(relay);
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });
});
