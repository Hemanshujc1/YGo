import { describe, expect, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalFileStorage } from "../src/adapters/file-storage";
import { createLocalIdentityVerifier } from "../src/adapters/identity-verifier";
import { createLocalMailer } from "../src/adapters/mailer";
import { createLocalPushSender } from "../src/adapters/push-sender";
import { createLocalSmsSender } from "../src/adapters/sms-sender";

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

describe("local FileStorage", () => {
  it("addresses a key as a file under its directory", async () => {
    const storage = createLocalFileStorage("/tmp/ygo-files");
    expect(await storage.uploadUrl("proofs/a.jpg", "image/jpeg")).toBe(
      "file:///tmp/ygo-files/proofs/a.jpg",
    );
    expect(await storage.downloadUrl("proofs/a.jpg")).toBe("file:///tmp/ygo-files/proofs/a.jpg");
  });
});
