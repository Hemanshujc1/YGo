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
  | ApiFailure;

/** A call the server answered with anything other than success. */
interface ApiFailure {
  ok: false;
  status: number;
  code: ErrorCode;
  fields?: string[];
}

export interface ApiClientOptions {
  /** The API's origin, such as `https://api.example.com`; `""` for the page's own origin. */
  baseUrl: string;
  /** Defaults to the global `fetch`, looked up on each call. */
  fetch?: typeof fetch;
  /** How long a call waits, including reading the body, before it rejects. */
  timeoutMs?: number;
  /** Sent with each request when the caller supplies its app identity. */
  app?: AppIdentity;
  /**
   * Called whenever any call is answered UPDATE_REQUIRED (426): the server no
   * longer serves this app's version, so every later call will be refused too.
   */
  onUpdateRequired?: () => void;
}

export function createApiClient({
  baseUrl,
  fetch: fetchFn,
  timeoutMs = 10_000,
  app,
  onUpdateRequired,
}: ApiClientOptions) {
  const origin = baseUrl.trim().replace(/\/+$/, "");

  /** Sends a GET and reads its JSON body; a body that is not JSON reads as undefined. */
  async function get(path: string) {
    const response = await (fetchFn ?? fetch)(`${origin}${path}`, {
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
    return { ok: response.ok, status: response.status, body };
  }

  /** The result for an answer that is not a success, from its error envelope. */
  function failure(status: number, body: unknown): ApiFailure {
    const envelope = ErrorEnvelope.safeParse(body);
    if (!envelope.success) return { ok: false, status, code: "INTERNAL" };
    if (envelope.data.error.code === "UPDATE_REQUIRED") onUpdateRequired?.();
    return { ok: false, status, code: envelope.data.error.code, fields: envelope.data.error.fields };
  }

  return {
    /** `GET /v1/healthz`: whether the server and its database both answer. */
    async health(): Promise<ApiResult<HealthResponse>> {
      const { ok, status, body } = await get("/v1/healthz");
      if (!ok) return failure(status, body);
      const parsed = HealthResponse.safeParse(body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, status, code: "INTERNAL" };
    },

    /**
     * `GET /v1/version-check`: whether the server still serves this app's
     * version. 204 is ok; a version that is too old gets UPDATE_REQUIRED.
     */
    async versionCheck(): Promise<ApiResult<undefined>> {
      const { ok, status, body } = await get("/v1/version-check");
      if (status === 204) return { ok: true, data: undefined };
      return ok ? { ok: false, status, code: "INTERNAL" } : failure(status, body);
    },
  };
}
