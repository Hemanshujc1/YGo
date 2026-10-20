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

  /** In memory only, so it is gone when the app closes. */
  let accessToken: string | null = null;
  /** The refresh under way, which every call refused meanwhile waits for. */
  let refreshing: Promise<Answer | null> | null = null;
  /**
   * Bumped by `turn` when a sign-out starts and when a sign-in is kept. A
   * refresh, call or sign-in begun before then changes nothing.
   */
  let epoch = 0;
  /**
   * The epoch the latest sign-out is ending, until a sign-in. Calls made in
   * it answer UNAUTHENTICATED without asking the server, and a refresh in it
   * that is refused doesn't call `onSignedOut`.
   */
  let leaving = -1;
  /** The store's latest task. Each task waits for the one before, so they land in the order made. */
  let storing: Promise<unknown> = Promise.resolve();

  /** A sign-in or sign-out replaces the session: a refresh begun before it is no longer shared. */
  function turn() {
    epoch += 1;
    refreshing = null;
  }

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
   * Keeps a new session: the access token in memory at once, the refresh
   * token in the store after any change queued before it. Call it straight
   * after checking `epoch`, with no wait between. Rejects if the store
   * cannot save it.
   */
  function keep(next: Session): Promise<void> {
    accessToken = next.accessToken;
    return inTurn(async () => session?.set(next.refreshToken));
  }

  /** Forgets the session, in memory and then in the store, on the same terms as `keep`. */
  function forget(): Promise<void> {
    accessToken = null;
    return inTurn(async () => session?.clear());
  }

  /**
   * Trades the saved refresh token for a new pair. Answers null when it is
   * done, with the result in `accessToken`, or else the answer to pass on.
   * The store is cleared only when the server refuses the token (401, or a
   * 400 naming it), or answers a success that breaks the contract, since
   * that has used the token up. Any other answer keeps it, and with no
   * network this rejects and keeps it too. If the store cannot save the new
   * refresh token this rejects, but keeps the new access token: the server
   * has used the old refresh token up, so the session lasts until its next
   * refresh rather than ending now.
   */
  async function refresh(): Promise<Answer | null> {
    const started = epoch;
    const refreshToken = await inTurn(async () => session?.get());
    // A sign-in or sign-out since has replaced this session.
    if (epoch !== started) return null;
    if (!refreshToken) return NO_SESSION;
    const answer = await send("POST", "/v1/auth/refresh", { refreshToken });
    if (epoch !== started) return null;
    if (answer.ok) {
      const next = Session.safeParse(answer.body);
      if (next.success) {
        await keep(next.data);
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
      await forget();
      if (epoch === started && epoch !== leaving) onSignedOut?.();
      return refused ? NO_SESSION : unreadable;
    }
    return answer.status === 400 ? unreadable : answer;
  }

  /**
   * Refreshes, unless the refused access token was already replaced or the
   * session has ended meanwhile. Calls refused together share one refresh:
   * the server ends a session whose old refresh token is used twice.
   */
  function renew(refused: string | null): Promise<Answer | null> {
    if (accessToken !== refused) return Promise.resolve(null);
    if (refreshing) return refreshing;
    const mine: Promise<Answer | null> = refresh().finally(() => {
      // A sign-in or sign-out may have started a newer one meanwhile.
      if (refreshing === mine) refreshing = null;
    });
    refreshing = mine;
    return mine;
  }

  /**
   * Sends a call with the access token. With none in memory, as when the app
   * has just opened, it refreshes first; while a refresh is under way it
   * waits for it. When the server answers 401 and the call has not
   * refreshed yet, it refreshes and sends the call again; so it refreshes
   * once at most. A call never crosses a sign-in or sign-out: it answers
   * UNAUTHENTICATED rather than be sent with another session's token. One
   * made during or after a sign-out, other than the sign-out's own, answers
   * UNAUTHENTICATED without asking the server.
   */
  async function signedIn(method: string, path: string, json?: unknown, signingOut = false): Promise<Answer> {
    const started = epoch;
    if (started === leaving && !signingOut) return NO_SESSION;
    const current = () => (epoch === started ? accessToken : null);
    const renewedFirst = !accessToken || refreshing !== null;
    if (renewedFirst) {
      const refused = await renew(accessToken);
      if (refused) return refused;
    }
    const token = current();
    if (!token) return NO_SESSION;
    const answer = await send(method, path, json, token);
    if (answer.status !== 401 || renewedFirst) return answer;
    // A sign-in or sign-out since has replaced this session, so don't spend its refresh token.
    if (epoch !== started) return NO_SESSION;
    const refused = await renew(token);
    if (refused) return refused;
    const renewed = current();
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
     * An answer that arrives after a sign-out begun after it, or after
     * another sign-in was kept, is dropped as UNAUTHENTICATED. If the store
     * cannot save the session, this rejects and keeps none.
     */
    async verifyCode(body: VerifyCodeBody): Promise<ApiResult<Account>> {
      if (!session) throw new Error("createApiClient needs a session store to sign in");
      const started = epoch;
      const answered = result(await send("POST", "/v1/auth/verify", body), Session);
      if (!answered.ok) return answered;
      if (epoch !== started) return { ok: false, status: 401, code: "UNAUTHENTICATED" };
      turn();
      try {
        await keep(answered.data);
      } catch (err) {
        if (accessToken === answered.data.accessToken) accessToken = null;
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
     * it here. It is forgotten even when the server cannot be reached, but
     * not when a sign-in begun meanwhile has already been kept. A refresh
     * under way lands first, so the server is told with its new token.
     * Rejects only when the store cannot be cleared, since the session would
     * then come back at the next launch.
     */
    async signOut(): Promise<void> {
      // From here, other calls are refused and a refused refresh is not the session ending by itself.
      leaving = epoch;
      // Its failure is the caller's to see; sign-out goes on regardless.
      if (refreshing) await refreshing.catch(() => null);
      turn();
      const mine = epoch;
      leaving = mine;
      try {
        // Read like any other answer, so UPDATE_REQUIRED still fires onUpdateRequired.
        empty(await signedIn("POST", "/v1/auth/sign-out", undefined, true));
      } catch {
        // No network: the phone forgets the session all the same.
      } finally {
        if (epoch === mine) await forget();
      }
    },
  };
}
