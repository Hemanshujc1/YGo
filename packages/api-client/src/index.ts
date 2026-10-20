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

/**
 * One session, from a sign-in (or the app opening) until it is replaced. A
 * sign-in or sign-out puts a new one in its place, so work begun on an older
 * one can never touch the newer one.
 */
interface Life {
  /** In memory only, so it is gone when the app closes. */
  access: string | null;
  /** The newest refresh token; undefined until read from the store. */
  refresh: string | null | undefined;
  /** The refresh under way, which every call refused meanwhile waits for. */
  renewing: Promise<Answer | null> | null;
  /**
   * Replaced by a sign-in: work still under way on it stops. A session a
   * sign-out is ending is no longer current but not over, since it may still
   * refresh to tell the server.
   */
  over: boolean;
}

const life = (access: string | null, refresh: string | null | undefined): Life => ({
  access,
  refresh,
  renewing: null,
  over: false,
});

export interface ApiClientOptions {
  /** The API's origin, such as `https://api.example.com`; `""` for the page's own origin. */
  baseUrl: string;
  /** Defaults to the global `fetch`, looked up on each call. */
  fetch?: typeof fetch;
  /**
   * How long each request waits, including reading the body, before it
   * rejects. A signed-in call may send up to three: the call, a refresh, and
   * the call again. A sign-out may first wait for a refresh already under
   * way, so up to four.
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

  /** The current session. At launch its refresh token is still in the store. */
  let current = life(null, undefined);
  /** The store's latest task. Each task waits for the one before, so they land in the order made. */
  let storing: Promise<unknown> = Promise.resolve();

  /** Runs a task on the store after those already queued. */
  function inTurn<T>(task: () => Promise<T>): Promise<T> {
    const done = storing.then(task);
    storing = done.catch(() => undefined);
    return done;
  }

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

  /**
   * Trades the session's refresh token for a new pair. Answers null when it
   * is done, with the result in `on`, or else the answer to pass on. Only the
   * current session writes the store: a sign-out's session is no longer
   * current, and one replaced by a sign-in stops here.
   *
   * The new pair is used at once; the store saves the refresh token behind
   * the calls waiting for it. If it cannot, the next refresh saves again.
   * The session ends when the server refuses the token (401, or a 400 naming
   * it), or answers a success that breaks the contract, since that has used
   * the token up. Any other answer keeps it, and with no network this
   * rejects and keeps it too.
   */
  async function refresh(on: Life): Promise<Answer | null> {
    if (on.refresh === undefined) {
      const saved = await inTurn(async () => session?.get());
      if (on.over) return NO_SESSION;
      on.refresh = saved ?? null;
    }
    if (!on.refresh) return NO_SESSION;
    const answer = await send("POST", "/v1/auth/refresh", { refreshToken: on.refresh });
    if (on.over) return NO_SESSION;
    if (answer.ok) {
      const next = Session.safeParse(answer.body);
      if (next.success) {
        on.access = next.data.accessToken;
        on.refresh = next.data.refreshToken;
        if (on === current) void inTurn(async () => session?.set(next.data.refreshToken)).catch(() => undefined);
        return null;
      }
    }
    // Read as INTERNAL: a body that breaks the contract, or a 400 about something else.
    const unreadable: Answer = { ok: false, status: answer.status, body: undefined };
    const envelope = ErrorEnvelope.safeParse(answer.body);
    const refused =
      answer.status === 401 ||
      (answer.status === 400 && envelope.success && (envelope.data.error.fields ?? []).includes("refreshToken"));
    if (refused || answer.ok) {
      on.access = null;
      on.refresh = null;
      if (on === current) {
        try {
          await inTurn(async () => session?.clear());
        } catch (err) {
          // Read the store again next time, so the refusal and the clear are tried again.
          on.refresh = undefined;
          throw err;
        }
        if (on === current) onSignedOut?.();
      }
      return refused ? NO_SESSION : unreadable;
    }
    return answer.status === 400 ? unreadable : answer;
  }

  /**
   * Refreshes, unless the refused access token was already replaced. Calls
   * refused together share one refresh: the server ends a session whose old
   * refresh token is used twice.
   */
  function renew(on: Life, refused: string | null): Promise<Answer | null> {
    if (on.access !== refused) return Promise.resolve(null);
    on.renewing ??= refresh(on).finally(() => {
      on.renewing = null;
    });
    return on.renewing;
  }

  /**
   * Sends a call with the session's access token. With none in memory, as
   * when the app has just opened, it refreshes first; while a refresh is
   * under way it waits for it. When the server answers 401 and the call has
   * not refreshed yet, it refreshes and sends the call again; so it
   * refreshes once at most. A call keeps to the session it began in: once a
   * sign-in or sign-out replaces it, the call answers UNAUTHENTICATED rather
   * than be sent with another session's token. A sign-out passes the session
   * it is ending as `ending`.
   */
  async function signedIn(method: string, path: string, json?: unknown, ending?: Life): Promise<Answer> {
    const on = ending ?? current;
    const live = () => ending !== undefined || on === current;
    const renewedFirst = !on.access || on.renewing !== null;
    if (renewedFirst) {
      const refused = await renew(on, on.access);
      if (refused) return refused;
    }
    const token = live() ? on.access : null;
    if (!token) return NO_SESSION;
    const answer = await send(method, path, json, token);
    if (answer.status !== 401 || renewedFirst) return answer;
    // Replaced since, so don't spend its refresh token.
    if (!live()) return NO_SESSION;
    const refused = await renew(on, token);
    if (refused) return refused;
    const renewed = live() ? on.access : null;
    return renewed ? send(method, path, json, renewed) : NO_SESSION;
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
     * An answer that arrives after a sign-out or another sign-in begun after
     * it is dropped as UNAUTHENTICATED. If the store cannot save the session,
     * this rejects and keeps none, unless a call has refreshed it meanwhile.
     */
    async verifyCode(body: VerifyCodeBody): Promise<ApiResult<Account>> {
      if (!session) throw new Error("createApiClient needs a session store to sign in");
      const started = current;
      const answered = result(await send("POST", "/v1/auth/verify", body), Session);
      if (!answered.ok) return answered;
      if (current !== started) return { ok: false, status: 401, code: "UNAUTHENTICATED" };
      const next = life(answered.data.accessToken, answered.data.refreshToken);
      started.over = true;
      current = next;
      try {
        await inTurn(() => session.set(answered.data.refreshToken));
      } catch (err) {
        // A refresh meanwhile has replaced the pair, and saves its own.
        if (next.refresh === answered.data.refreshToken) {
          next.access = null;
          next.refresh = null;
        }
        throw err;
      }
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
     * it here. The session is replaced the moment this is called, so other
     * calls answer UNAUTHENTICATED from then on, and a sign-in begun
     * meanwhile is kept. It is forgotten even when the server cannot be
     * reached, unless a sign-in kept meanwhile holds a session. A refresh under way lands first, so the server is told with
     * its new token. Rejects only when the store cannot be cleared, since the
     * session would then come back at the next launch.
     */
    async signOut(): Promise<void> {
      const ending = current;
      const after = life(null, null);
      current = after;
      try {
        // Its failure is the caller's to see; sign-out goes on regardless.
        if (ending.renewing) await ending.renewing.catch(() => null);
        // Read like any other answer, so UPDATE_REQUIRED still fires onUpdateRequired.
        empty(await signedIn("POST", "/v1/auth/sign-out", undefined, ending));
      } catch {
        // No network: the phone forgets the session all the same.
      } finally {
        if (!current.refresh) await inTurn(async () => session?.clear());
      }
    },
  };
}
