import { ErrorEnvelope, HealthResponse, type ErrorCode } from "@ygo/contracts";

/**
 * What a call returns once the server has answered. A failed fetch (the
 * network is down, the server is unreachable) rejects instead.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: ErrorCode };

export interface ApiClientOptions {
  /** The API's origin, such as `https://api.example.com`; `""` for the page's own origin. */
  baseUrl: string;
  fetch?: typeof fetch;
}

export function createApiClient({
  baseUrl,
  fetch: fetchFn = globalThis.fetch.bind(globalThis),
}: ApiClientOptions) {
  return {
    /** `GET /v1/healthz`: whether the server and its database both answer. */
    async health(): Promise<ApiResult<HealthResponse>> {
      const response = await fetchFn(`${baseUrl}/v1/healthz`, {
        headers: { accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => undefined);

      // A body that breaks the contract, or a code this client does not know,
      // counts as INTERNAL (see ErrorCode in @ygo/contracts).
      if (response.ok) {
        const parsed = HealthResponse.safeParse(body);
        return parsed.success
          ? { ok: true, data: parsed.data }
          : { ok: false, status: response.status, code: "INTERNAL" };
      }
      const envelope = ErrorEnvelope.safeParse(body);
      return {
        ok: false,
        status: response.status,
        code: envelope.success ? envelope.data.error.code : "INTERNAL",
      };
    },
  };
}
