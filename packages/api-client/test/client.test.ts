import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/index";

const answering = (
  status: number,
  body: BodyInit | null,
  baseUrl = "https://api.test",
  onUpdateRequired?: () => void,
) => {
  const requested: string[] = [];
  const requestHeaders: Headers[] = [];
  const client = createApiClient({
    baseUrl,
    app: { name: "customer", version: "1.2.3" },
    onUpdateRequired,
    fetch: (input, init) => {
      requested.push(String(input));
      requestHeaders.push(new Headers(init?.headers));
      return Promise.resolve(new Response(body, { status }));
    },
  });
  return { client, requested, requestHeaders };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health", () => {
  it("returns the parsed answer when the server is healthy", async () => {
    const { client, requested } = answering(200, '{"status":"ok"}');
    expect(await client.health()).toEqual({ ok: true, data: { status: "ok" } });
    expect(requested).toEqual(["https://api.test/v1/healthz"]);
  });

  it("ignores whitespace and trailing slashes on the base URL", async () => {
    const { client, requested } = answering(200, '{"status":"ok"}', " https://api.test// ");
    await client.health();
    expect(requested).toEqual(["https://api.test/v1/healthz"]);
  });

  it("calls the page's own origin when the base URL is blank", async () => {
    const { client, requested } = answering(200, '{"status":"ok"}', "  ");
    await client.health();
    expect(requested).toEqual(["/v1/healthz"]);
  });

  it("sends the application name and version with the request", async () => {
    const { client, requestHeaders } = answering(200, '{"status":"ok"}');
    await client.health();
    expect(requestHeaders[0]?.get("x-ygo-app-name")).toBe("customer");
    expect(requestHeaders[0]?.get("x-ygo-app-version")).toBe("1.2.3");
  });

  it("keeps existing callers working until they supply app identity", async () => {
    let headers: Headers | undefined;
    const client = createApiClient({
      baseUrl: "https://api.test",
      fetch: (_input, init) => {
        headers = new Headers(init?.headers);
        return Promise.resolve(new Response('{"status":"ok"}'));
      },
    });
    expect(await client.health()).toEqual({ ok: true, data: { status: "ok" } });
    expect(headers?.has("x-ygo-app-name")).toBe(false);
    expect(headers?.has("x-ygo-app-version")).toBe(false);
  });

  it("returns the machine code from the error envelope", async () => {
    const { client } = answering(503, '{"error":{"code":"UNAVAILABLE"}}');
    expect(await client.health()).toEqual({ ok: false, status: 503, code: "UNAVAILABLE" });
  });

  it("passes on the fields a VALIDATION_FAILED names", async () => {
    const { client } = answering(400, '{"error":{"code":"VALIDATION_FAILED","fields":["phone"]}}');
    expect(await client.health()).toEqual({
      ok: false,
      status: 400,
      code: "VALIDATION_FAILED",
      fields: ["phone"],
    });
  });

  it("treats a code it does not know as INTERNAL", async () => {
    const { client } = answering(503, '{"error":{"code":"TEAPOT"}}');
    expect(await client.health()).toEqual({ ok: false, status: 503, code: "INTERNAL" });
  });

  it("treats a 200 that breaks the contract as INTERNAL", async () => {
    const { client } = answering(200, '{"status":"degraded"}');
    expect(await client.health()).toEqual({ ok: false, status: 200, code: "INTERNAL" });
  });

  it("treats a body that is not JSON as INTERNAL", async () => {
    const { client } = answering(502, "<html>Bad Gateway</html>");
    expect(await client.health()).toEqual({ ok: false, status: 502, code: "INTERNAL" });
  });

  it("rejects when the body cannot be read", async () => {
    const broken = new ReadableStream({
      start: (controller) => controller.error(new TypeError("terminated")),
    });
    const { client } = answering(200, broken);
    await expect(client.health()).rejects.toThrow("terminated");
  });

  it("rejects when the server cannot be reached", async () => {
    const client = createApiClient({
      baseUrl: "https://api.test",
      app: { name: "customer", version: "1.2.3" },
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(client.health()).rejects.toThrow("fetch failed");
  });

  it("rejects when the server does not answer in time", async () => {
    const client = createApiClient({
      baseUrl: "https://api.test",
      app: { name: "customer", version: "1.2.3" },
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(client.health()).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
  });

  it("uses the global fetch as it is at call time", async () => {
    const client = createApiClient({ baseUrl: "https://api.test", app: { name: "customer", version: "1.2.3" } });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response('{"status":"ok"}')));
    expect(await client.health()).toEqual({ ok: true, data: { status: "ok" } });
  });
});

describe("versionCheck", () => {
  it("is ok when the server serves this version", async () => {
    const { client, requested, requestHeaders } = answering(204, null);
    expect(await client.versionCheck()).toEqual({ ok: true, data: undefined });
    expect(requested).toEqual(["https://api.test/v1/version-check"]);
    expect(requestHeaders[0]?.get("x-ygo-app-name")).toBe("customer");
    expect(requestHeaders[0]?.get("x-ygo-app-version")).toBe("1.2.3");
  });

  it("returns UPDATE_REQUIRED when the version is too old", async () => {
    const { client } = answering(426, '{"error":{"code":"UPDATE_REQUIRED"}}');
    expect(await client.versionCheck()).toEqual({ ok: false, status: 426, code: "UPDATE_REQUIRED" });
  });

  it("treats another success status as INTERNAL", async () => {
    const { client } = answering(200, '{"status":"ok"}');
    expect(await client.versionCheck()).toEqual({ ok: false, status: 200, code: "INTERNAL" });
  });

  it("treats an error body that is not the envelope as INTERNAL", async () => {
    const { client } = answering(502, "<html>Bad Gateway</html>");
    expect(await client.versionCheck()).toEqual({ ok: false, status: 502, code: "INTERNAL" });
  });
});

describe("onUpdateRequired", () => {
  const counting = (status: number, body: BodyInit | null) => {
    const signal = vi.fn();
    return { client: answering(status, body, undefined, signal).client, signal };
  };
  const tooOld = '{"error":{"code":"UPDATE_REQUIRED"}}';

  // The server never refuses /v1/healthz; health() stands in for every later call.
  it("fires when any call is answered UPDATE_REQUIRED", async () => {
    const { client, signal } = counting(426, tooOld);
    await client.health();
    await client.versionCheck();
    expect(signal).toHaveBeenCalledTimes(2);
  });

  it("does not fire on success or any other answer", async () => {
    for (const [status, body] of [
      [200, '{"status":"ok"}'],
      [204, null],
      [503, '{"error":{"code":"UNAVAILABLE"}}'],
      [502, "<html>Bad Gateway</html>"],
    ] as const) {
      const { client, signal } = counting(status, body);
      await client.health();
      await client.versionCheck();
      expect(signal).not.toHaveBeenCalled();
    }
  });

  it("does not fire when the call fails without an answer", async () => {
    const signal = vi.fn();
    const client = createApiClient({
      baseUrl: "https://api.test",
      fetch: () => Promise.reject(new TypeError("Network request failed")),
      onUpdateRequired: signal,
    });
    await expect(client.versionCheck()).rejects.toThrow(TypeError);
    expect(signal).not.toHaveBeenCalled();
  });
});
