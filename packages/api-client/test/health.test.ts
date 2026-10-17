import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/index";

const answering = (status: number, body: BodyInit, baseUrl = "https://api.test") => {
  const requested: string[] = [];
  const client = createApiClient({
    baseUrl,
    fetch: (input) => {
      requested.push(String(input));
      return Promise.resolve(new Response(body, { status }));
    },
  });
  return { client, requested };
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

  it("returns the machine code from the error envelope", async () => {
    const { client } = answering(503, '{"error":{"code":"UNAVAILABLE"}}');
    expect(await client.health()).toEqual({ ok: false, status: 503, code: "UNAVAILABLE" });
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
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(client.health()).rejects.toThrow("fetch failed");
  });

  it("rejects when the server does not answer in time", async () => {
    const client = createApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(client.health()).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
  });

  it("uses the global fetch as it is at call time", async () => {
    const client = createApiClient({ baseUrl: "https://api.test" });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response('{"status":"ok"}')));
    expect(await client.health()).toEqual({ ok: true, data: { status: "ok" } });
  });
});
