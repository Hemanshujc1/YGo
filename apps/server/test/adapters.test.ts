import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalFileStorage } from "../src/adapters/file-storage";
import { createLocalIdentityVerifier } from "../src/adapters/identity-verifier";
import { createLocalMailer, createMailpitMailer, createSesMailer } from "../src/adapters/mailer";
import { createExpoPushSender, createLocalPushSender, type Push } from "../src/adapters/push-sender";
import { createLocalSmsSender } from "../src/adapters/sms-sender";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local Clock", () => {
  it("stands still until the test sets or advances it", () => {
    const clock = createLocalClock(new Date("2026-10-17T09:00:00Z"));
    expect(clock.now()).toEqual(new Date("2026-10-17T09:00:00Z"));

    clock.advance(120_000);
    expect(clock.now()).toEqual(new Date("2026-10-17T09:02:00Z"));

    clock.set(new Date("2026-10-19T00:00:00Z"));
    expect(clock.now()).toEqual(new Date("2026-10-19T00:00:00Z"));
  });
});

describe("local IdentityVerifier", () => {
  it("proves the email of a token it minted, for that provider only", async () => {
    const verifier = createLocalIdentityVerifier();
    const token = verifier.mint("google", "asha@example.com");
    expect(await verifier.verify("google", token)).toEqual({ email: "asha@example.com" });
    expect(await verifier.verify("apple", token)).toBeNull();
    expect(await verifier.verify("google", "forged")).toBeNull();
  });
});

describe("local senders", () => {
  it("record what they were given", async () => {
    const mailer = createLocalMailer();
    const push = createLocalPushSender();
    const sms = createLocalSmsSender();

    await mailer.send({ to: "asha@example.com", subject: "Code", text: "123456" });
    const push1 = { to: "ExponentPushToken[x]", title: "New order", body: "#1042", data: { notificationId: "n", orderId: null }, loud: true };
    expect(await push.send([push1])).toEqual(["sent"]);
    await sms.sendCode("+919800000000", "123456");

    expect(mailer.sent).toEqual([{ to: "asha@example.com", subject: "Code", text: "123456" }]);
    expect(push.sent).toEqual([push1]);
    expect(sms.sent).toEqual([{ to: "+919800000000", code: "123456" }]);
  });
});

describe("SES mailer", () => {
  it("sends a plain-text message with the configured sender", async () => {
    const send = vi.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({});
    await createSesMailer("hello@example.com", "ap-south-1", { send }).send({
      to: "asha@example.com", subject: "Code", text: "123456",
    });

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]?.[0] as { constructor: { name: string }; input: unknown };
    expect(command.constructor.name).toBe("SendEmailCommand");
    expect(command.input).toEqual({
      FromEmailAddress: "hello@example.com",
      Destination: { ToAddresses: ["asha@example.com"] },
      Content: { Simple: {
        Subject: { Data: "Code", Charset: "UTF-8" },
        Body: { Text: { Data: "123456", Charset: "UTF-8" } },
      } },
    });
  });

  it("rejects a failed send", async () => {
    const send = vi.fn<(command: unknown) => Promise<unknown>>().mockRejectedValue(new Error("SES unavailable"));
    await expect(createSesMailer("hello@example.com", "ap-south-1", { send }).send({
      to: "asha@example.com", subject: "Code", text: "123456",
    })).rejects.toThrow("SES unavailable");
  });
});

describe("Mailpit mailer", () => {
  it("posts the plain-text message to the send API", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await createMailpitMailer("hello@example.com", "http://localhost:8025").send({
      to: "asha@example.com", subject: "Code", text: "123456",
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(new URL("http://localhost:8025/api/v1/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: { Email: "hello@example.com" },
        To: [{ Email: "asha@example.com" }],
        Subject: "Code",
        Text: "123456",
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it("aborts a timed out request and does not expose fetch error details", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret token")), { once: true });
      }),
    );
    const sending = createMailpitMailer("hello@example.com", "http://localhost:8025").send({
      to: "asha@example.com", subject: "Code", text: "123456",
    });
    const rejected = expect(sending).rejects.toThrow("Mailpit send timed out");

    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(sending).rejects.not.toThrow("secret token");
  });

  it("does not expose fetch error details on network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret token in URL"));
    await expect(createMailpitMailer("hello@example.com", "http://localhost:8025").send({
      to: "asha@example.com", subject: "Code", text: "123456",
    })).rejects.toThrow("Mailpit send failed");
  });

  it("rejects a failed HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    await expect(createMailpitMailer("hello@example.com", "http://localhost:8025").send({
      to: "asha@example.com", subject: "Code", text: "123456",
    })).rejects.toThrow("Mailpit send failed with HTTP 500");
  });
});

describe("local FileStorage", () => {
  it("addresses a key as a file under its directory", async () => {
    const storage = createLocalFileStorage("/tmp/ygo-files");
    expect(await storage.uploadUrl("proofs/a.jpg", "image/jpeg")).toBe(
      "file:///tmp/ygo-files/proofs/a.jpg",
    );
    expect(await storage.downloadUrl("proofs/a.jpg")).toBe("file:///tmp/ygo-files/proofs/a.jpg");
  });

  it("refuses a key that escapes its directory", async () => {
    const storage = createLocalFileStorage("/tmp/ygo-files");
    await expect(storage.downloadUrl("../etc/passwd")).rejects.toThrow("escapes");
  });
});

describe("Expo push sender (#505)", () => {
  const push = (to: string, loud = false): Push => ({ to, title: "Order #1001 accepted", body: "Sai is getting it ready.", data: { notificationId: "n", orderId: "o" }, loud });

  it("sends 100 at a time, marks the loud one for the new-orders channel and reports dead tokens", async () => {
    const bodies: Array<Array<Record<string, unknown>>> = [];
    const sender = createExpoPushSender(async (body) => {
      const messages = JSON.parse(body) as Array<Record<string, unknown>>;
      bodies.push(messages);
      return Response.json({ data: messages.map((message) => message.to === "ExponentPushToken[gone]"
        ? { status: "error", details: { error: "DeviceNotRegistered" } }
        : message.to === "ExponentPushToken[busy]" ? { status: "error", details: { error: "MessageRateExceeded" } } : { status: "ok" }) });
    });
    const pushes = [push("ExponentPushToken[loud]", true), push("ExponentPushToken[gone]"), push("ExponentPushToken[busy]"),
      ...Array.from({ length: 98 }, (_, i) => push(`ExponentPushToken[${i}]`))];

    const results = await sender.send(pushes);

    expect(bodies.map((batch) => batch.length)).toEqual([100, 1]);
    expect(bodies[0]?.[0]).toEqual({ to: "ExponentPushToken[loud]", title: "Order #1001 accepted", body: "Sai is getting it ready.", data: { notificationId: "n", orderId: "o", loud: true },
      channelId: "new-orders", sound: "new_order.wav", priority: "high", interruptionLevel: "time-sensitive" });
    expect(bodies[0]?.[1]).toMatchObject({ sound: "default", data: { notificationId: "n", orderId: "o" } });
    expect(bodies[0]?.[1]?.data).not.toHaveProperty("loud");
    expect(bodies[0]?.[1]).not.toHaveProperty("channelId");
    expect(results).toHaveLength(101);
    expect(results.slice(0, 3)).toEqual(["sent", "dead", "failed"]);
    expect(new Set(results.slice(3))).toEqual(new Set(["sent"]));
  });

  it("counts a push as sent only on an ok ticket: a missing ticket or an answer it can't read is failed", async () => {
    const answers = [
      Response.json({ data: [{ status: "ok" }] }),
      Response.json({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] }),
      new Response("<html>bad gateway</html>", { status: 200 }),
      Response.json({ data: { status: "ok" } }),
    ];
    const sender = createExpoPushSender(async () => answers.shift() ?? Response.json({}));
    expect(await sender.send([push("ExponentPushToken[a]"), push("ExponentPushToken[b]")])).toEqual(["sent", "failed"]);
    for (let i = 0; i < 3; i += 1) expect(await sender.send([push("ExponentPushToken[a]")])).toEqual(["failed"]);
  });

  it("fails only the messages of a request Expo refused or never answered, so the queue tries those again", async () => {
    let calls = 0;
    const sender = createExpoPushSender(async (body) => {
      calls += 1;
      if (calls === 2) return new Response("down", { status: 503 });
      if (calls === 3) throw new Error("timed out");
      return Response.json({ data: (JSON.parse(body) as unknown[]).map(() => ({ status: "ok" })) });
    });
    const results = await sender.send(Array.from({ length: 250 }, (_, i) => push(`ExponentPushToken[${i}]`)));
    expect([results.slice(0, 100), results.slice(100)].map((part) => [...new Set(part)])).toEqual([["sent"], ["failed"]]);
  });
});
