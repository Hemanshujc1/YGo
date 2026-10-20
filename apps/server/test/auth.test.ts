import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { ErrorEnvelope, Session } from "@ygo/contracts";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer, type Mail, type Mailer } from "../src/adapters/mailer";
import { connectDatabase } from "../src/db";

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

  it("keeps the database available while ten email sends are held", async () => {
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
