import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Account, ErrorEnvelope, Session } from "@ygo/contracts";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer, type Mail, type Mailer } from "../src/adapters/mailer";
import { connectDatabase } from "../src/db";
import { accessToken, deriveKeys, digest, successorToken } from "../src/tokens";

const database = connectDatabase(inject("databaseUrl"));
const secret = "01234567890123456789012345678901";
const activeApps: ReturnType<typeof buildApp>[] = [];
afterAll(() => database.close());
afterEach(async () => {
  await Promise.all(activeApps.splice(0).map((app) => app.close()));
});

function harness(options: { mailer?: Mailer; start?: Date; captureLogs?: boolean } = {}) {
  const mailer = options.mailer ?? createLocalMailer();
  const clock = createLocalClock(options.start ?? new Date("2030-01-01T00:00:00.000Z"));
  const logLines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { logLines.push(chunk.toString()); callback(); } });
  const app = buildApp({
    checkDatabase: database.ping,
    database,
    mailer,
    clock,
    authTokenSecret: secret,
    logger: options.captureLogs ? { level: "trace", stream } : false,
  });
  activeApps.push(app);
  const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const requestCode = (email: string, ip = address) =>
    app.inject({ method: "POST", url: "/v1/auth/code", headers: { "x-forwarded-for": ip }, payload: { email } });
  const verify = (email: string, code: string) =>
    app.inject({ method: "POST", url: "/v1/auth/verify", headers: { "x-forwarded-for": address }, payload: { email, code } });
  return { app, mailer, clock, address, requestCode, verify, logLines };
}

function inbox(mailer: Mailer): Mail[] {
  return (mailer as Mailer & { sent: Mail[] }).sent;
}

function sentMail(mailer: Mailer, index: number): Mail {
  const mail = inbox(mailer)[index];
  if (!mail) throw new Error("Expected a sent test email");
  return mail;
}

function codeFrom(mail: Mail): string {
  return mail.text.match(/code is (\d{6})/)?.[1] ?? "";
}

function email(): string {
  return `${randomUUID()}@example.com`;
}

describe("email sign-in routes", () => {
  it("sends a code, creates an account at first verification, and reuses it later", async () => {
    const h = harness();
    const address = email();
    const sent = await h.requestCode(address);
    expect(sent.statusCode).toBe(204);
    expect(sent.body).toBe("");
    const first = await h.verify(address, codeFrom(sentMail(h.mailer, 0)));
    expect(first.statusCode).toBe(200);
    const session = Session.parse(first.json());
    expect(session.account).toMatchObject({ email: address, name: null, phone: null });

    h.clock.advance(30_000);
    await h.requestCode(address);
    const second = await h.verify(address, codeFrom(sentMail(h.mailer, 1)));
    expect(Session.parse(second.json()).account.id).toBe(session.account.id);
    expect(await database.pool.query("SELECT count(*)::int AS count FROM accounts WHERE email = $1", [address]).then((result) => result.rows[0].count)).toBe(1);
  });

  it("refuses wrong, expired, and replaced codes", async () => {
    const h = harness();
    const address = email();
    await h.requestCode(address);
    const firstCode = codeFrom(sentMail(h.mailer, 0));
    const wrong = await h.verify(address, firstCode === "000000" ? "000001" : "000000");
    expect(wrong.statusCode).toBe(400);
    expect(ErrorEnvelope.parse(wrong.json()).error.code).toBe("CODE_WRONG");
    h.clock.advance(30_000);
    await h.requestCode(address);
    const replaced = await h.verify(address, firstCode);
    expect(replaced.statusCode).toBe(400);
    expect(replaced.json()).toEqual({ error: { code: "CODE_EXPIRED" } });
    h.clock.advance(5 * 60_000);
    const expired = await h.verify(address, codeFrom(sentMail(h.mailer, 1)));
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toEqual({ error: { code: "CODE_EXPIRED" } });
  });

  it("locks after five wrong tries, blocks sends, then allows a code after fifteen minutes", async () => {
    const h = harness();
    const address = email();
    await h.requestCode(address);
    const firstCode = codeFrom(sentMail(h.mailer, 0));
    let wrong = await h.verify(address, firstCode === "000000" ? "000001" : "000000");
    expect(wrong.json()).toEqual({ error: { code: "CODE_WRONG" } });
    h.clock.advance(30_000);
    await h.requestCode(address);
    const rightCode = codeFrom(sentMail(h.mailer, 1));
    for (let attempt = 2; attempt <= 5; attempt++) {
      wrong = await h.verify(address, rightCode === "000000" ? "000001" : "000000");
      expect(wrong.statusCode).toBe(attempt === 5 ? 429 : 400);
      expect(wrong.json()).toEqual({ error: { code: attempt === 5 ? "CODE_LOCKED" : "CODE_WRONG" } });
    }
    expect((await h.verify(address, rightCode)).json()).toEqual({ error: { code: "CODE_LOCKED" } });
    expect((await h.requestCode(address)).json()).toEqual({ error: { code: "CODE_LOCKED" } });
    expect(inbox(h.mailer)).toHaveLength(2);
    h.clock.advance(15 * 60_000);
    expect((await h.requestCode(address)).statusCode).toBe(204);
  });

  it("preserves a wrong-try lock set while a replacement code is being sent", async () => {
    const local = createLocalMailer();
    let holdReplacement = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let replacementStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const mailer: Mailer = {
      async send(mail) {
        await local.send(mail);
        if (holdReplacement) {
          replacementStarted();
          await held;
        }
      },
    };
    const h = harness({ mailer });
    const address = email();
    await h.requestCode(address);
    const wrongCode = codeFrom(sentMail(local, 0)) === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await h.verify(address, wrongCode)).json()).toEqual({ error: { code: "CODE_WRONG" } });
    }

    h.clock.advance(30_000);
    holdReplacement = true;
    const replacement = h.requestCode(address);
    await sendStarted;
    expect((await h.verify(address, wrongCode)).json()).toEqual({ error: { code: "CODE_LOCKED" } });
    release();
    expect((await replacement).statusCode).toBe(204);
    expect((await h.verify(address, codeFrom(sentMail(local, 1)))).json()).toEqual({ error: { code: "CODE_LOCKED" } });
  });

  it("resets wrong tries when the previous code expired", async () => {
    const h = harness();
    const address = email();
    await h.requestCode(address);
    const wrongCode = codeFrom(sentMail(h.mailer, 0)) === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await h.verify(address, wrongCode)).json()).toEqual({ error: { code: "CODE_WRONG" } });
    }
    h.clock.advance(5 * 60_000);
    expect((await h.requestCode(address)).statusCode).toBe(204);
    expect((await h.verify(address, wrongCode)).json()).toEqual({ error: { code: "CODE_WRONG" } });
    const result = await database.pool.query("SELECT wrong_tries FROM login_codes WHERE email = $1", [address]);
    expect(result.rows[0]?.wrong_tries).toBe(1);
  });

  it("applies the 30-second and five-per-hour email limits", async () => {
    const h = harness();
    const address = email();
    expect((await h.requestCode(address)).statusCode).toBe(204);
    expect((await h.requestCode(address)).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
    for (let sent = 1; sent < 5; sent++) {
      h.clock.advance(30_000);
      expect((await h.requestCode(address)).statusCode).toBe(204);
    }
    h.clock.advance(30_000);
    expect((await h.requestCode(address)).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
    expect(inbox(h.mailer)).toHaveLength(5);
  });

  it("applies the twenty-per-hour forwarded-address limit", async () => {
    const h = harness();
    for (let sent = 0; sent < 20; sent++) {
      if (sent > 0) h.clock.advance(30_000);
      expect((await h.requestCode(email(), "203.0.113.8")).statusCode).toBe(204);
    }
    h.clock.advance(30_000);
    expect((await h.requestCode(email(), "203.0.113.8")).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
  });

  it("counts forwarded IPv6 addresses by their /64 prefix", async () => {
    const h = harness();
    for (let sent = 0; sent < 20; sent++) {
      if (sent) h.clock.advance(30_000);
      expect((await h.requestCode(email(), `2001:db8:1:2::${sent + 1}`)).statusCode).toBe(204);
    }
    h.clock.advance(30_000);
    expect((await h.requestCode(email(), "2001:db8:1:2::ffff")).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
    expect((await h.requestCode(email(), "2001:db8:1:3::1")).statusCode).toBe(204);
  });

  it("counts IPv4-mapped IPv6 addresses by their embedded IPv4 address", async () => {
    const h = harness();
    for (let sent = 0; sent < 20; sent++) {
      expect((await h.requestCode(email(), "::ffff:203.0.113.12")).statusCode).toBe(204);
    }
    expect((await h.requestCode(email(), "::ffff:203.0.113.12")).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
    expect((await h.requestCode(email(), "::ffff:203.0.113.13")).statusCode).toBe(204);
    expect((await h.requestCode(email(), "203.0.113.12")).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
  });

  it("keeps the database available and other addresses unblocked during held sends", async () => {
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let allStarted!: () => void;
    const tenStarted = new Promise<void>((resolve) => { allStarted = resolve; });
    const mailer: Mailer = {
      async send() {
        started++;
        if (started === 10) allStarted();
        await held;
      },
    };
    const h = harness({ mailer });
    const sends = Array.from({ length: 10 }, (_, index) => h.requestCode(`${randomUUID()}-${index}@example.com`));
    await tenStarted;
    expect((await h.app.inject({ method: "GET", url: "/v1/healthz" })).statusCode).toBe(200);
    release();
    expect((await Promise.all(sends)).every((response) => response.statusCode === 204)).toBe(true);
  });

  it("does not block another email from a different address while delivery is held", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const local = createLocalMailer();
    const mailer: Mailer = {
      async send(mail) {
        if (mail.to === "held@example.com") {
          started();
          await held;
        }
        await local.send(mail);
      },
    };
    const h = harness({ mailer });
    const first = h.requestCode("held@example.com", "203.0.113.10");
    await sendStarted;
    const second = await h.requestCode("other@example.com", "203.0.113.11");
    expect(second.statusCode).toBe(204);
    release();
    expect((await first).statusCode).toBe(204);
  });

  it("keeps the old code active and does not count a failed delivery", async () => {
    const local = createLocalMailer();
    let fail = false;
    const mailer: Mailer = {
      async send(mail) {
        if (fail) throw new Error("mail provider unavailable");
        await local.send(mail);
      },
    };
    const h = harness({ mailer });
    const address = email();
    await h.requestCode(address);
    const previousCode = codeFrom(sentMail(local, 0));
    h.clock.advance(30_000);
    fail = true;
    const failed = await h.requestCode(address);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: { code: "UNAVAILABLE" } });
    expect((await h.verify(address, previousCode)).statusCode).toBe(200);
    expect(inbox(local)).toHaveLength(1);
  });

  it("logs mail delivery errors without logging the email or code", async () => {
    const h = harness({
      captureLogs: true,
      mailer: {
        async send(mail) {
          const code = codeFrom(mail);
          throw new Error(`failed ${mail.to} ${mail.text} ${code}`);
        },
      },
    });
    const address = email();
    const response = await h.requestCode(address);
    expect(response.statusCode).toBe(503);
    const log = h.logLines.join("");
    expect(log).toContain("failed [redacted]");
    expect(log).not.toContain(address);
    expect(log).not.toContain("sign-in code is");
  });

  it("does not use an email send slot when the mailer fails", async () => {
    const local = createLocalMailer();
    let fail = false;
    const mailer: Mailer = {
      async send(mail) {
        if (fail) throw new Error("mail provider unavailable");
        await local.send(mail);
      },
    };
    const h = harness({ mailer });
    const address = email();
    for (let sent = 0; sent < 4; sent++) {
      if (sent) h.clock.advance(30_000);
      expect((await h.requestCode(address)).statusCode).toBe(204);
    }
    fail = true;
    h.clock.advance(30_000);
    expect((await h.requestCode(address)).statusCode).toBe(503);
    fail = false;
    h.clock.advance(30_000);
    expect((await h.requestCode(address)).statusCode).toBe(204);
    expect(inbox(local)).toHaveLength(5);
  });

  it("never returns the emailed code in an API answer", async () => {
    const h = harness({ captureLogs: true });
    const address = email();
    await h.requestCode(address);
    const code = codeFrom(sentMail(h.mailer, 0));
    const verified = await h.verify(address, code);
    expect(verified.body).not.toContain(code);
    await h.app.close();
    activeApps.splice(activeApps.indexOf(h.app), 1);
    expect(h.logLines.join("")).not.toContain(code);
  });
});

const keys = deriveKeys(secret);
const DAY_MS = 24 * 60 * 60_000;

async function signIn(h: ReturnType<typeof harness>) {
  const address = email();
  await h.requestCode(address);
  const answer = await h.verify(address, codeFrom(sentMail(h.mailer, inbox(h.mailer).length - 1)));
  const session = Session.parse(answer.json());
  return { ...session, sessionId: claims(session.accessToken).sid };
}

function claims(token: string): { sub: string; sid: string; exp: number } {
  return JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf(".")), "base64url").toString("utf8"));
}

function refresh(h: ReturnType<typeof harness>, refreshToken: string) {
  return h.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
}

/** The refresh token a successful refresh returned, or the error code it gave. */
async function refreshed(h: ReturnType<typeof harness>, refreshToken: string): Promise<string> {
  const answer = await refresh(h, refreshToken);
  if (answer.statusCode === 200) return Session.parse(answer.json()).refreshToken;
  expect(answer.statusCode).toBe(401);
  return ErrorEnvelope.parse(answer.json()).error.code;
}

function signOut(h: ReturnType<typeof harness>, token?: string) {
  return h.app.inject({
    method: "POST",
    url: "/v1/auth/sign-out",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function sessionExists(sessionId: string): Promise<boolean> {
  return Boolean((await database.pool.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId])).rowCount);
}

async function tokenCount(sessionId: string): Promise<number> {
  const result = await database.pool.query("SELECT count(*)::int AS count FROM refresh_tokens WHERE session_id = $1", [sessionId]);
  return result.rows[0].count;
}

describe("sessions", () => {
  it("rotates on refresh, and the new token refreshes again", async () => {
    const h = harness();
    const s = await signIn(h);
    const answer = await refresh(h, s.refreshToken);
    expect(answer.statusCode).toBe(200);
    const next = Session.parse(answer.json());
    expect(next.refreshToken).not.toBe(s.refreshToken);
    expect(next.account).toEqual(s.account);
    expect(claims(next.accessToken).sid).toBe(s.sessionId);
    expect((await signOut(h, next.accessToken)).statusCode).toBe(204);
  });

  it("refuses a malformed refresh body with a 400 on refreshToken", async () => {
    const h = harness();
    const answer = await refresh(h, "");
    expect(answer.statusCode).toBe(400);
    expect(ErrorEnvelope.parse(answer.json()).error).toEqual({ code: "VALIDATION_FAILED", fields: ["refreshToken"] });
  });

  it("signs out, after which the access and refresh tokens are refused at once", async () => {
    const h = harness();
    const s = await signIn(h);
    const out = await signOut(h, s.accessToken);
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe("");
    expect(await sessionExists(s.sessionId)).toBe(false);
    expect((await signOut(h, s.accessToken)).json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
    expect(await refreshed(h, s.refreshToken)).toBe("UNAUTHENTICATED");
  });

  it("refuses a missing, expired, tampered or mismatched access token", async () => {
    const h = harness();
    const s = await signIn(h);
    const other = await signIn(h);
    const dot = s.accessToken.lastIndexOf(".");
    const [payload, signature] = [s.accessToken.slice(0, dot), s.accessToken.slice(dot + 1)];
    const otherPayload = other.accessToken.slice(0, other.accessToken.lastIndexOf("."));
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    const extraClaim = Buffer.from(JSON.stringify({ ...claims(s.accessToken), extra: 1 })).toString("base64url");
    const refused = [
      undefined,
      "",
      `${otherPayload}.${signature}`,
      `${payload}.${flipped}`,
      `${extraClaim}.${digest(keys.access, extraClaim)}`,
      accessToken(keys, other.account.id, s.sessionId, h.clock.now()),
    ];
    for (const token of refused) {
      expect((await signOut(h, token)).json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
    }
    h.clock.advance(15 * 60_000);
    expect((await signOut(h, s.accessToken)).statusCode).toBe(401);
    h.clock.set(new Date("2030-01-01T00:00:00.000Z"));
    expect(await sessionExists(s.sessionId)).toBe(true);
    expect((await signOut(h, s.accessToken)).statusCode).toBe(204);
  });

  it("ends the whole session when a replaced token is used after 60 s", async () => {
    const h = harness();
    const s = await signIn(h);
    const t2 = await refreshed(h, s.refreshToken);
    h.clock.advance(60_001);
    expect(await refreshed(h, s.refreshToken)).toBe("UNAUTHENTICATED");
    expect(await sessionExists(s.sessionId)).toBe(false);
    expect(await refreshed(h, t2)).toBe("UNAUTHENTICATED");
  });

  it("refuses a token unused for 90 days, and each refresh restarts the 90 days", async () => {
    const h = harness();
    const s = await signIn(h);
    h.clock.advance(89 * DAY_MS);
    const t2 = await refreshed(h, s.refreshToken);
    h.clock.advance(89 * DAY_MS);
    const t3 = await refreshed(h, t2);
    expect(t3).not.toBe("UNAUTHENTICATED");
    h.clock.advance(90 * DAY_MS);
    expect(await refreshed(h, t3)).toBe("UNAUTHENTICATED");
  });

  it("gives every concurrent refresh of one token the same successor, with one rotation", async () => {
    for (let run = 0; run < 20; run++) {
      const h = harness();
      const s = await signIn(h);
      const answers = await Promise.all([1, 2, 3].slice(0, 2 + (run % 2)).map(() => refreshed(h, s.refreshToken)));
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).not.toBe("UNAUTHENTICATED");
      expect(await tokenCount(s.sessionId)).toBe(2);
      // Retries arriving together inside the window get it too, and change nothing.
      h.clock.advance(30_000);
      expect(await Promise.all([1, 2, 3].map(() => refreshed(h, s.refreshToken)))).toEqual([answers[0], answers[0], answers[0]]);
      expect(await tokenCount(s.sessionId)).toBe(2);
      await h.app.close();
    }
  });

  it("answers a retry after a lost answer with the same successor", async () => {
    const h = harness();
    const s = await signIn(h);
    const t2 = await refreshed(h, s.refreshToken);
    h.clock.advance(10_000);
    expect(await refreshed(h, s.refreshToken)).toBe(t2);
    const t3 = await refreshed(h, t2);
    h.clock.advance(10_000);
    expect(await refreshed(h, t2)).toBe(t3);
    expect(await refreshed(h, t3)).not.toBe("UNAUTHENTICATED");
  });

  it("allows a retry up to exactly 60 s after replacement, and ends the session at 60.001 s", async () => {
    const h = harness();
    const s = await signIn(h);
    const t2 = await refreshed(h, s.refreshToken);
    h.clock.advance(59_999);
    expect(await refreshed(h, s.refreshToken)).toBe(t2);
    h.clock.advance(1);
    expect(await refreshed(h, s.refreshToken)).toBe(t2);
    h.clock.advance(1);
    expect(await refreshed(h, s.refreshToken)).toBe("UNAUTHENTICATED");
    expect(await sessionExists(s.sessionId)).toBe(false);
  });

  it("refuses a delayed retry once its successor is replaced, and keeps the session", async () => {
    const h = harness();
    const s = await signIn(h);
    const t2 = await refreshed(h, s.refreshToken);
    const t3 = await refreshed(h, t2);
    h.clock.advance(20_000);
    expect(await refreshed(h, s.refreshToken)).toBe("UNAUTHENTICATED");
    expect(await sessionExists(s.sessionId)).toBe(true);
    expect(await refreshed(h, t3)).not.toBe("UNAUTHENTICATED");
  });

  it("ends the session when a stolen copy is used after the other side rotates on", async () => {
    const h = harness();
    const s = await signIn(h);
    const [phone, thief] = await Promise.all([refreshed(h, s.refreshToken), refreshed(h, s.refreshToken)]);
    expect(thief).toBe(phone);
    const t3 = await refreshed(h, phone);
    h.clock.advance(60_001);
    expect(await refreshed(h, thief)).toBe("UNAUTHENTICATED");
    expect(await sessionExists(s.sessionId)).toBe(false);
    expect(await refreshed(h, t3)).toBe("UNAUTHENTICATED");
  });

  it("ends the session when a token two rotations back is used after 60 s", async () => {
    const h = harness();
    const s = await signIn(h);
    const t2 = await refreshed(h, s.refreshToken);
    await refreshed(h, t2);
    h.clock.advance(60_001);
    expect(await refreshed(h, s.refreshToken)).toBe("UNAUTHENTICATED");
    expect(await sessionExists(s.sessionId)).toBe(false);
  });

  it("refuses fabricated tokens without touching the real session", async () => {
    const h = harness();
    const s = await signIn(h);
    const fabricated = [
      randomBytes(32).toString("base64url"),
      successorToken(keys, s.sessionId, 5, s.refreshToken),
      `${s.sessionId}.${randomBytes(32).toString("base64url")}`,
      `${s.refreshToken}x`,
    ];
    for (const token of fabricated) expect(await refreshed(h, token)).toBe("UNAUTHENTICATED");
    expect(await tokenCount(s.sessionId)).toBe(1);
    expect(await refreshed(h, s.refreshToken)).not.toBe("UNAUTHENTICATED");
  });

  it("keeps successors unique to their session and generation, and keys separate", () => {
    const token = randomBytes(32).toString("base64url");
    const [a, b] = [randomUUID(), randomUUID()];
    const successors = [successorToken(keys, a, 1, token), successorToken(keys, b, 1, token), successorToken(keys, a, 2, token)];
    expect(new Set(successors).size).toBe(3);
    expect(new Set(Object.values(keys).map((key) => key.toString("hex"))).size).toBe(4);
    const payload = Buffer.from(JSON.stringify({ sub: a, sid: b, exp: 2_000_000_000 })).toString("base64url");
    expect(digest(keys.refreshHash, payload)).not.toBe(digest(keys.access, payload));
  });
});

describe("profile routes", () => {
  const phone = () => `+919${randomInt(1_000_000_000).toString().padStart(9, "0")}`;

  function call(h: ReturnType<typeof harness>, method: "GET" | "PUT" | "PATCH", url: string, token?: string, payload?: object) {
    return h.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
  }

  it("returns the signed-in account, sets the profile, and changes only the name", async () => {
    const h = harness();
    const s = await signIn(h);
    const number = phone();
    const before = await call(h, "GET", "/v1/me", s.accessToken);
    expect(before.statusCode).toBe(200);
    expect(Account.parse(before.json())).toEqual(s.account);

    const set = await call(h, "PUT", "/v1/me/profile", s.accessToken, { name: "  Asha   Kulkarni ", phone: number });
    expect(set.statusCode).toBe(200);
    expect(Account.parse(set.json())).toEqual({ ...s.account, name: "Asha Kulkarni", phone: number });
    const stored = await database.pool.query("SELECT phone_verified FROM accounts WHERE id = $1", [s.account.id]);
    expect(stored.rows[0].phone_verified).toBe(false);

    const renamed = await call(h, "PATCH", "/v1/me", s.accessToken, { name: "Meera Shah" });
    expect(renamed.statusCode).toBe(200);
    expect(Account.parse(renamed.json())).toMatchObject({ name: "Meera Shah", phone: number });
    expect((await call(h, "GET", "/v1/me", s.accessToken)).json()).toEqual(renamed.json());
    const forbidden = await call(h, "PATCH", "/v1/me", s.accessToken, { name: "Meera Shah", phone: "+919000000000" });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["phone"] } });
  });

  it("requires a profile on PATCH, while GET, PUT, and sign-out stay available", async () => {
    const h = harness();
    const s = await signIn(h);
    const blocked = await call(h, "PATCH", "/v1/me", s.accessToken, { name: "Meera Shah" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: { code: "PROFILE_REQUIRED" } });
    expect((await call(h, "GET", "/v1/me", s.accessToken)).statusCode).toBe(200);
    expect((await signOut(h, s.accessToken)).statusCode).toBe(204);
  });

  it("accepts the same phone again and updates the name, but refuses a different phone", async () => {
    const h = harness();
    const s = await signIn(h);
    const number = phone();
    const first = await call(h, "PUT", "/v1/me/profile", s.accessToken, { name: "Asha Kulkarni", phone: number });
    expect(first.statusCode).toBe(200);
    const repeat = await call(h, "PUT", "/v1/me/profile", s.accessToken, { name: "Meera Shah", phone: number });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({ name: "Meera Shah", phone: number });
    const changed = await call(h, "PUT", "/v1/me/profile", s.accessToken, { name: "Asha Kulkarni", phone: phone() });
    expect(changed.statusCode).toBe(400);
    expect(changed.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["phone"] } });
    expect((await call(h, "GET", "/v1/me", s.accessToken)).json()).toEqual(repeat.json());
  });

  it("maps a concurrent phone uniqueness clash to PHONE_IN_USE", async () => {
    const h = harness();
    const [first, second] = await Promise.all([signIn(h), signIn(h)]);
    const number = phone();
    const answers = await Promise.all([first, second].map((s) =>
      call(h, "PUT", "/v1/me/profile", s.accessToken, { name: "Asha Kulkarni", phone: number }),
    ));
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.statusCode === 409)?.json()).toEqual({ error: { code: "PHONE_IN_USE" } });
  });

  it("refuses a missing or bad token on every profile route", async () => {
    const h = harness();
    for (const [method, url, payload] of [
      ["GET", "/v1/me", undefined],
      ["PUT", "/v1/me/profile", { name: "Asha Kulkarni", phone: "+919876543210" }],
      ["PATCH", "/v1/me", { name: "Asha Kulkarni" }],
    ] as const) {
      for (const token of [undefined, "bad.token"]) {
        const answer = await call(h, method, url, token, payload);
        expect(answer.statusCode).toBe(401);
        expect(answer.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
      }
    }
  });
});
