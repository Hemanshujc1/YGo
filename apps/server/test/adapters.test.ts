import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalFileStorage } from "../src/adapters/file-storage";
import { createLocalIdentityVerifier } from "../src/adapters/identity-verifier";
import { createLocalMailer, createMailpitMailer, createSesMailer } from "../src/adapters/mailer";
import { createLocalPushSender } from "../src/adapters/push-sender";
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
    await push.send({ to: "ExponentPushToken[x]", title: "New order", body: "#1042" });
    await sms.sendCode("+919800000000", "123456");

    expect(mailer.sent).toEqual([{ to: "asha@example.com", subject: "Code", text: "123456" }]);
    expect(push.sent).toEqual([{ to: "ExponentPushToken[x]", title: "New order", body: "#1042" }]);
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
