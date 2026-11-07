import { describe, expect, it, vi } from "vitest";
import { customerAppUrl, openApp, shopkeeperAppUrl } from "../src/switch-app-flow";

describe("switching apps (#551, ACC-4)", () => {
  it("links to each app by the scheme in its app.json, with no path or data", () => {
    expect(customerAppUrl).toBe("ygo-customer://");
    expect(shopkeeperAppUrl).toBe("ygo-shopkeeper://");
  });

  it("opens the link and says it opened", async () => {
    const open = vi.fn().mockResolvedValue(true);
    expect(await openApp(open, shopkeeperAppUrl)).toBe(true);
    expect(open).toHaveBeenCalledWith("ygo-shopkeeper://");
  });

  it("answers false, and does not throw, when the other app is not installed", async () => {
    expect(await openApp(() => Promise.reject(new Error("Unable to open URL")), customerAppUrl)).toBe(false);
  });
});
