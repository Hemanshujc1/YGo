import {
  APP_NAME_HEADER,
  APP_VERSION_HEADER,
  ErrorEnvelope,
  HealthResponse,
  type AppIdentity,
  type ErrorCode,
} from "@ygo/contracts";

/**
 * What a call returns once the server has answered. With VALIDATION_FAILED,
 * `fields` names the request fields that broke their rule. A failed fetch (the
 * network is down, the server is unreachable, the call timed out) rejects
 * instead.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: ErrorCode; fields?: string[] };

export interface ApiClientOptions {
  /** The API's origin, such as `https://api.example.com`; `""` for the page's own origin. */
  baseUrl: string;
  /** Defaults to the global `fetch`, looked up on each call. */
  fetch?: typeof fetch;
  /** How long a call waits, including reading the body, before it rejects. */
  timeoutMs?: number;
  /** Sent with each request when the caller supplies its app identity. */
  app?: AppIdentity;
}

export function createApiClient({
  baseUrl,
  fetch: fetchFn,
  timeoutMs = 10_000,
  app,
}: ApiClientOptions) {
  const origin = baseUrl.trim().replace(/\/+$/, "");

  return {
    /** `GET /v1/healthz`: whether the server and its database both answer. */
    async health(): Promise<ApiResult<HealthResponse>> {
      const response = await (fetchFn ?? fetch)(`${origin}/v1/healthz`, {
        headers: {
          accept: "application/json",
          ...(app && { [APP_NAME_HEADER]: app.name, [APP_VERSION_HEADER]: app.version }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      // A body that is not JSON, breaks the contract, or carries a code this
      // client does not know counts as INTERNAL (see ErrorCode in
      // @ygo/contracts). Failing to read the body at all rejects.
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }

      if (response.ok) {
        const parsed = HealthResponse.safeParse(body);
        return parsed.success
          ? { ok: true, data: parsed.data }
          : { ok: false, status: response.status, code: "INTERNAL" };
      }
      const envelope = ErrorEnvelope.safeParse(body);
      return envelope.success
        ? {
            ok: false,
            status: response.status,
            code: envelope.data.error.code,
            fields: envelope.data.error.fields,
          }
        : { ok: false, status: response.status, code: "INTERNAL" };
    },
  };
}
