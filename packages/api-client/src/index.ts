import {
  Account,
  APP_NAME_HEADER,
  APP_VERSION_HEADER,
  ErrorEnvelope,
  HealthResponse,
  Session,
  type AppIdentity,
  type ChangeNameBody,
  type ErrorCode,
  type RequestCodeBody,
  type SetProfileBody,
  type VerifyCodeBody,
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

/**
 * Where the refresh token is kept between launches. The mobile apps back it
 * with the phone's secure storage; the client never touches storage itself.
 */
export interface SessionStore {
  get(): Promise<string | null>;
  set(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

/** A server answer before it is checked against its contract. */
interface Answer {
  ok: boolean;
  status: number;
  body: unknown;
}

/** A contract schema. Structural, since only @ygo/contracts imports zod. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** What a signed-in call answers, without asking the server, when there is no session. */
const NO_SESSION: Answer = { ok: false, status: 401, body: { error: { code: "UNAUTHENTICATED" } } };

export interface ApiClientOptions {
  /** The API's origin, such as `https://api.example.com`; `""` for the page's own origin. */
  baseUrl: string;
  /** Defaults to the global `fetch`, looked up on each call. */
  fetch?: typeof fetch;
  /**
   * How long each request waits, including reading the body, before it
   * rejects. A signed-in call may send up to three: a refresh, the call, and
   * the call again.
   */
  timeoutMs?: number;
  /** Sent with each request when the caller supplies its app identity. */
  app?: AppIdentity;
  /**
   * Called on every answer with UPDATE_REQUIRED (426): the server no longer
   * serves this app's version, so its later calls are refused too (all but
   * `/v1/healthz`). It may fire more than once; the caller keeps the state.
   */
  onUpdateRequired?: () => void;
  /** Needed to sign in. Without it every signed-in call answers UNAUTHENTICATED. */
  session?: SessionStore;
  /**
   * Called when the server refuses the saved refresh token (expired, revoked
   * or reused): the session has ended and the store is cleared. Not called
   * for `signOut`, which the person asked for.
   */
  onSignedOut?: () => void;
}

export function createApiClient({
  baseUrl,
  fetch: fetchFn,
  timeoutMs = 10_000,
  app,
  onUpdateRequired,
  session,
  onSignedOut,
}: ApiClientOptions) {
  const origin = baseUrl.trim().replace(/\/+$/, "");

  /** In memory only, so it is gone when the app closes. */
  let accessToken: string | null = null;
  /** The refresh under way, which every call refused meanwhile waits for. */
  let refreshing: Promise<Answer | null> | null = null;
  let signingOut = false;
  /** Bumped when a sign-in or sign-out finishes, so a refresh begun before it is ignored. */
  let epoch = 0;

  /** Sends a call and reads its JSON body; a body that is not JSON reads as undefined. */
  async function send(method: string, path: string, json?: unknown, token: string | null = null): Promise<Answer> {
    const response = await (fetchFn ?? fetch)(`${origin}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(json !== undefined && { "content-type": "application/json" }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...(app && { [APP_NAME_HEADER]: app.name, [APP_VERSION_HEADER]: app.version }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
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

  /**
   * The result for an answer that is not a success, from its error envelope.
   * Calls `onUpdateRequired` for UPDATE_REQUIRED, so call it once per answer.
   */
  function failure(status: number, body: unknown): ApiFailure {
    const envelope = ErrorEnvelope.safeParse(body);
    if (!envelope.success) return { ok: false, status, code: "INTERNAL" };
    if (envelope.data.error.code === "UPDATE_REQUIRED") onUpdateRequired?.();
    return { ok: false, status, code: envelope.data.error.code, fields: envelope.data.error.fields };
  }

  /** The result for an answer whose success carries a body matching `schema`. */
  function result<T>(answer: Answer, schema: Schema<T>): ApiResult<T> {
    if (!answer.ok) return failure(answer.status, answer.body);
    const parsed = schema.safeParse(answer.body);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, status: answer.status, code: "INTERNAL" };
  }

  /** The result for an answer whose success is 204; another success is INTERNAL. */
  function empty(answer: Answer): ApiResult<undefined> {
    if (answer.status === 204) return { ok: true, data: undefined };
    return answer.ok
      ? { ok: false, status: answer.status, code: "INTERNAL" }
      : failure(answer.status, answer.body);
  }

  /** Keeps a new session: the refresh token in the store, the access token in memory. */
  async function keep(next: Session) {
    await session?.set(next.refreshToken);
    accessToken = next.accessToken;
  }

  /**
   * Trades the saved refresh token for a new pair. Answers null on success,
   * or else the answer to pass on. Only the server refusing the token (401,
   * or 400 for a malformed one) clears the store. Any other answer keeps it,
   * and with no network this rejects and keeps it too.
   */
  async function refresh(): Promise<Answer | null> {
    const started = epoch;
    const refreshToken = await session?.get();
    if (!refreshToken) return NO_SESSION;
    const answer = await send("POST", "/v1/auth/refresh", { refreshToken });
    if (epoch !== started) return accessToken ? null : NO_SESSION;
    if (answer.status === 401 || answer.status === 400) {
      accessToken = null;
      await session?.clear();
      if (!signingOut) onSignedOut?.();
      return NO_SESSION;
    }
    if (!answer.ok) return answer;
    const next = Session.safeParse(answer.body);
    if (!next.success) return { ok: false, status: answer.status, body: undefined };
    await keep(next.data);
    return null;
  }

  /**
   * Refreshes, unless the refused access token was already replaced or the
   * session has ended meanwhile. Calls refused together share one refresh:
   * the server ends a session whose old refresh token is used twice.
   */
  function renew(refused: string | null): Promise<Answer | null> {
    if (accessToken !== refused) return Promise.resolve(accessToken ? null : NO_SESSION);
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /**
   * Sends a call with the access token. With none in memory, as when the app
   * has just opened, it refreshes first; while a refresh is under way it
   * waits for it. When the server answers 401 it refreshes once and sends
   * the call again.
   */
  async function signedIn(method: string, path: string, json?: unknown): Promise<Answer> {
    if (!accessToken || refreshing) {
      const refused = await renew(accessToken);
      if (refused) return refused;
    }
    const token = accessToken;
    const answer = await send(method, path, json, token);
    if (answer.status !== 401) return answer;
    const refused = await renew(token);
    if (refused) return refused;
    return send(method, path, json, accessToken);
  }

  return {
    /** `GET /v1/healthz`: whether the server and its database both answer. */
    async health(): Promise<ApiResult<HealthResponse>> {
      return result(await send("GET", "/v1/healthz"), HealthResponse);
    },

    /**
     * `GET /v1/version-check`: whether the server still serves this app's
     * version. 204 is ok; a version that is too old gets UPDATE_REQUIRED.
     */
    async versionCheck(): Promise<ApiResult<undefined>> {
      return empty(await send("GET", "/v1/version-check"));
    },

    /** `POST /v1/auth/code`: email a sign-in code. */
    async requestCode(body: RequestCodeBody): Promise<ApiResult<undefined>> {
      return empty(await send("POST", "/v1/auth/code", body));
    },

    /**
     * `POST /v1/auth/verify`: the code from the email. On success the client
     * keeps the session and answers the account; the tokens never leave it.
     */
    async verifyCode(body: VerifyCodeBody): Promise<ApiResult<Account>> {
      if (!session) throw new Error("createApiClient needs a session store to sign in");
      const answered = result(await send("POST", "/v1/auth/verify", body), Session);
      if (!answered.ok) return answered;
      epoch += 1;
      await keep(answered.data);
      return { ok: true, data: answered.data.account };
    },

    /** `GET /v1/me`: the signed-in account. */
    async me(): Promise<ApiResult<Account>> {
      return result(await signedIn("GET", "/v1/me"), Account);
    },

    /** `PUT /v1/me/profile`: the name and phone each account gives once. */
    async setProfile(body: SetProfileBody): Promise<ApiResult<Account>> {
      return result(await signedIn("PUT", "/v1/me/profile", body), Account);
    },

    /** `PATCH /v1/me`: a new name. */
    async changeName(body: ChangeNameBody): Promise<ApiResult<Account>> {
      return result(await signedIn("PATCH", "/v1/me", body), Account);
    },

    /**
     * `POST /v1/auth/sign-out`: ends the session on the server, then forgets
     * it here. It is forgotten even when the server cannot be reached.
     */
    async signOut(): Promise<void> {
      signingOut = true;
      try {
        const answer = await signedIn("POST", "/v1/auth/sign-out");
        // Read like any other answer, so UPDATE_REQUIRED still fires onUpdateRequired.
        if (!answer.ok) failure(answer.status, answer.body);
      } catch {
        // No network: the phone forgets the session all the same.
      } finally {
        epoch += 1;
        accessToken = null;
        signingOut = false;
        await session?.clear();
      }
    },
  };
}
