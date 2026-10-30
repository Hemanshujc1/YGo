import {
  ShopStockResponse,
  SyncActionsResponse,
  type SyncActionsBody,
  Account,
  ErrorEnvelope,
  HealthResponse,
  IdentityChallenge,
  IdentitySignInResponse,
  type IdentityChallengeBody,
  type IdentityEmailRequired,
  type VerifyIdentityBody,
  MyShopApplicationResponse,
  PlacePointResponse,
  PlaceSearchResponse,
  SavedAddress,
  SavedAddressesResponse,
  Serviceability,
  FeedResponse,
  SearchResponse,
  ShopPageResponse,
  CartResponse,
  OrderResponse,
  type PlaceOrderBody,
  type SaveCartBody,
  type FeedQuery,
  type SearchQuery,
  Session,
  ShopApplication,
  ShopListingsResponse,
  OpeningStockResponse,
  ShopAgreementResponse,
  type AcceptShopAgreementBody,
  ShopHoursResponse,
  ShopHolidaysResponse,
  ShopOpenStatus,
  type ShopHoliday,
  type ShopOpenChange,
  type ShopHours,
  type ShopListingCatalogItem,
  type SaveShopListingBody as SaveShopListingInput,
  type OpeningStockBody as OpeningStockInput,
  type AppIdentity,
  type ChangeNameBody,
  type RequestCodeBody,
  type SaveAddressBody,
  type AddressPinBody,
  type SaveShopApplicationBody,
  type SendShopApplicationBody,
  type SetProfileBody,
  type SetThemeBody,
  type VerifyCodeBody,
  type WaitlistBody,
} from "@ygo/contracts";
import { createTransport, NO_SESSION, type Answer, type ApiResult } from "./transport";
export { createAdminApiClient, type AdminApiClientOptions } from "./admin";

/**
 * What a call returns once the server has answered. With VALIDATION_FAILED,
 * `fields` names the request fields that broke their rule. A failed fetch (the
 * network is down, the server is unreachable, the call timed out) rejects
 * instead.
 */
export type { ApiResult } from "./transport";

/**
 * Where the refresh token is kept between launches. The mobile apps back it
 * with the phone's secure storage; the client never touches storage itself.
 */
export interface SessionStore {
  get(): Promise<string | null>;
  set(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

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
  /**
   * Called with the error when the store cannot save a refreshed token. The
   * session keeps working and the next refresh saves again, so this is for a
   * log or crash report, not for the person. A sign-in the store cannot save
   * rejects instead.
   */
  onSaveFailed?: (error: unknown) => void;
}

export function createApiClient({
  baseUrl,
  fetch: fetchFn,
  timeoutMs = 10_000,
  app,
  onUpdateRequired,
  session,
  onSignedOut,
  onSaveFailed,
}: ApiClientOptions) {
  const transport = createTransport({ baseUrl, fetch: fetchFn, timeoutMs, app, onUpdateRequired });
  const { result, empty } = transport;
  const send = (method: string, path: string, json?: unknown, token: string | null = null) =>
    transport.send(method, path, json, { token });

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
        if (on === current) void inTurn(async () => session?.set(next.data.refreshToken)).catch((err: unknown) => onSaveFailed?.(err));
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

  async function signIn(path: string, body: VerifyCodeBody | VerifyIdentityBody) {
    if (!session) throw new Error("createApiClient needs a session store to sign in");
    const started = current;
    const answered = result(await send("POST", path, body), IdentitySignInResponse);
    if (!answered.ok) return answered;
    if (current !== started) return { ok: false as const, status: 401, code: "UNAUTHENTICATED" as const };
    if ("emailVerificationRequired" in answered.data) return { ok: true as const, data: answered.data };
    const tokens = answered.data;
    const next = life(tokens.accessToken, tokens.refreshToken);
    started.over = true;
    current = next;
    try {
      await inTurn(() => session.set(tokens.refreshToken));
    } catch (err) {
      // A refresh meanwhile has replaced the pair, and saves its own.
      if (next.refresh === tokens.refreshToken) {
        next.access = null;
        next.refresh = null;
      }
      throw err;
    }
    return { ok: true as const, data: answered.data.account };
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
      const answer = await signIn("/v1/auth/verify", body);
      // The email-code endpoint always returns an account.
      return answer.ok && "emailVerificationRequired" in answer.data
        ? { ok: false, status: 500, code: "INTERNAL" }
        : answer as ApiResult<Account>;
    },

    /** Starts a single provider attempt, before opening the native account picker. */
    async identityChallenge(body: IdentityChallengeBody): Promise<ApiResult<typeof IdentityChallenge._output>> {
      return result(await send("POST", "/v1/auth/identity/challenge", body), IdentityChallenge);
    },

    /** Verifies a signed provider token and saves the same session as email sign-in. */
    async verifyIdentity(body: VerifyIdentityBody): Promise<ApiResult<Account | typeof IdentityEmailRequired._output>> {
      return signIn("/v1/auth/identity", body);
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

    /** `PUT /v1/me/theme`: the account's theme, shared by both mobile apps. */
    async setTheme(body: SetThemeBody): Promise<ApiResult<Account>> {
      return result(await signedIn("PUT", "/v1/me/theme", body), Account);
    },

    /** `GET /v1/serviceability?pincode=`: whether the pincode is in an active Area (C15). */
    async checkServiceability(pincode: string): Promise<ApiResult<Serviceability>> {
      return result(await signedIn("GET", `/v1/serviceability?pincode=${encodeURIComponent(pincode)}`), Serviceability);
    },

    /** `GET /v1/feed`: the shops that can serve this place, nearest first (C04, DSC-1). */
    async feed({ pincode, latitude, longitude }: FeedQuery): Promise<ApiResult<FeedResponse>> {
      const query = new URLSearchParams({ pincode, latitude: String(latitude), longitude: String(longitude) });
      return result(await signedIn("GET", `/v1/feed?${query}`), FeedResponse);
    },

    /** `GET /v1/shops/:id`: C05, a shop that can serve this place with its products (DSC-2, DSC-4); 404 when it can't. */
    async shopPage(id: string, { pincode, latitude, longitude }: FeedQuery): Promise<ApiResult<ShopPageResponse>> {
      const query = new URLSearchParams({ pincode, latitude: String(latitude), longitude: String(longitude) });
      return result(await signedIn("GET", `/v1/shops/${encodeURIComponent(id)}?${query}`), ShopPageResponse);
    },

    /** `GET /v1/carts/:shopId`: C07, the Customer's cart at one shop priced for this place (#405); 404 when there's none and the shop can't serve. */
    async cart(shopId: string, { pincode, latitude, longitude }: FeedQuery): Promise<ApiResult<CartResponse>> {
      const query = new URLSearchParams({ pincode, latitude: String(latitude), longitude: String(longitude) });
      return result(await signedIn("GET", `/v1/carts/${encodeURIComponent(shopId)}?${query}`), CartResponse);
    },

    /** `PUT /v1/carts/:shopId`: saves the whole cart and answers with its new quote; CART_CHANGED when `revision` is old (#405). */
    async saveCart(shopId: string, { pincode, latitude, longitude }: FeedQuery, body: SaveCartBody): Promise<ApiResult<CartResponse>> {
      const query = new URLSearchParams({ pincode, latitude: String(latitude), longitude: String(longitude) });
      return result(await signedIn("PUT", `/v1/carts/${encodeURIComponent(shopId)}?${query}`, body), CartResponse);
    },

    /** `POST /v1/carts/:shopId/order`: places the cart for delivery to a saved address (#424); CART_CHANGED carries the cart as it is now. */
    async placeOrder(shopId: string, body: PlaceOrderBody): Promise<ApiResult<OrderResponse>> {
      return result(await signedIn("POST", `/v1/carts/${encodeURIComponent(shopId)}/order`, body), OrderResponse);
    },

    /** `GET /v1/orders/:id`: C09 and C19, one of the Customer's orders. */
    async order(id: string): Promise<ApiResult<OrderResponse>> {
      return result(await signedIn("GET", `/v1/orders/${encodeURIComponent(id)}`), OrderResponse);
    },

    /** `POST /v1/orders/:id/cancel`: free while the shop hasn't answered (ORD-5); ORDER_STATUS_CHANGED once it has. */
    async cancelOrder(id: string): Promise<ApiResult<OrderResponse>> {
      return result(await signedIn("POST", `/v1/orders/${encodeURIComponent(id)}/cancel`), OrderResponse);
    },

    /** `GET /v1/search`: C16, the shops that can serve this place matching the typed text, each with up to 5 matching products (DSC-3). */
    async search({ pincode, latitude, longitude, q }: SearchQuery): Promise<ApiResult<SearchResponse>> {
      const query = new URLSearchParams({ pincode, latitude: String(latitude), longitude: String(longitude), q });
      return result(await signedIn("GET", `/v1/search?${query}`), SearchResponse);
    },

    /** `POST /v1/waitlist`: "Leave my number" on C03. */
    async joinWaitlist(body: WaitlistBody): Promise<ApiResult<undefined>> {
      return empty(await signedIn("POST", "/v1/waitlist", body));
    },

    /** `GET /v1/me/addresses`: the account's saved addresses, newest first; with a shop, only those with a pin it delivers to (#427). */
    async savedAddresses(shopId?: string): Promise<ApiResult<SavedAddressesResponse>> {
      const query = shopId ? `?${new URLSearchParams({ shopId })}` : "";
      return result(await signedIn("GET", `/v1/me/addresses${query}`), SavedAddressesResponse);
    },

    /** `POST /v1/me/addresses`: saves a confirmed place. A new Home or Work replaces the old one. */
    async saveAddress(body: SaveAddressBody): Promise<ApiResult<SavedAddress>> {
      return result(await signedIn("POST", "/v1/me/addresses", body), SavedAddress);
    },

    /** `PUT /v1/me/addresses/:id/point`: puts the pin on a saved address that has none (#373). */
    async pinAddress(id: string, body: AddressPinBody): Promise<ApiResult<SavedAddress>> {
      return result(await signedIn("PUT", `/v1/me/addresses/${encodeURIComponent(id)}/point`, body), SavedAddress);
    },

    /** `DELETE /v1/me/addresses/:id` */
    async removeAddress(id: string): Promise<ApiResult<undefined>> {
      return empty(await signedIn("DELETE", `/v1/me/addresses/${encodeURIComponent(id)}`));
    },

    /** `GET /v1/places?text=&session=`: up to 5 places in India for C15's search (#257). */
    async searchPlaces(text: string, session: string): Promise<ApiResult<PlaceSearchResponse>> {
      const query = new URLSearchParams({ text, session });
      return result(await signedIn("GET", `/v1/places?${query}`), PlaceSearchResponse);
    },

    /** `GET /v1/places/point?id=&session=`: a picked match's point, ending the search's session. */
    async placePoint(id: string, session: string): Promise<ApiResult<PlacePointResponse>> {
      const query = new URLSearchParams({ id, session });
      return result(await signedIn("GET", `/v1/places/point?${query}`), PlacePointResponse);
    },

    /** `GET /v1/me/shop-application`: the account's shop application, or null before Start (S18). */
    async shopApplication(): Promise<ApiResult<MyShopApplicationResponse>> {
      return result(await signedIn("GET", "/v1/me/shop-application"), MyShopApplicationResponse);
    },

    /** `POST /v1/me/shop-application`: starts a Draft and makes the account its Owner (ACC-5). */
    async startShopApplication(): Promise<ApiResult<ShopApplication>> {
      return result(await signedIn("POST", "/v1/me/shop-application"), ShopApplication);
    },

    /** `PATCH /v1/me/shop-application`: Save draft. */
    async saveShopApplication(body: SaveShopApplicationBody): Promise<ApiResult<ShopApplication>> {
      return result(await signedIn("PATCH", "/v1/me/shop-application", body), ShopApplication);
    },

    /** `POST /v1/me/shop-application/send`: saves every field and sends the Draft for review. */
    async sendShopApplication(body: SendShopApplicationBody): Promise<ApiResult<ShopApplication>> {
      return result(await signedIn("POST", "/v1/me/shop-application/send", body), ShopApplication);
    },

    /** `GET /v1/me/shop-listings`: catalog packs available to this Owner and their shop settings. */
    async shopListings(): Promise<ApiResult<ShopListingsResponse>> {
      return result(await signedIn("GET", "/v1/me/shop-listings"), ShopListingsResponse);
    },

    /** `PUT /v1/me/shop-listings/:packId`: save this shop's settings for a catalog pack. */
    async saveShopListing(packId: string, body: SaveShopListingInput): Promise<ApiResult<ShopListingCatalogItem>> {
      return result(await signedIn("PUT", `/v1/me/shop-listings/${encodeURIComponent(packId)}`, body), ShopListingsResponse.shape.items.element);
    },

    /** Stock tools for the linked Owner or Staff member, after going Live. */
    async shopStock(): Promise<ApiResult<ShopStockResponse>> {
      return result(await signedIn("GET", "/v1/me/stock"), ShopStockResponse);
    },

    /** Ordered outbox push; acknowledged replays return their original per-action results. */
    async syncActions(body: SyncActionsBody): Promise<ApiResult<SyncActionsResponse>> {
      return result(await signedIn("POST", "/v1/sync/actions", body), SyncActionsResponse);
    },
    /** `POST /v1/me/shop-listings/:packId/opening-stock`: append the first stock movement; clientId makes offline retries safe. */
    async openingStock(packId: string, body: OpeningStockInput): Promise<ApiResult<OpeningStockResponse>> {
      return result(await signedIn("POST", `/v1/me/shop-listings/${encodeURIComponent(packId)}/opening-stock`, body), OpeningStockResponse);
    },

    /** `GET /v1/me/shop-agreement`: the onboarding agreement's rate card and the last acceptance (S19). */
    async shopAgreement(): Promise<ApiResult<ShopAgreementResponse>> {
      return result(await signedIn("GET", "/v1/me/shop-agreement"), ShopAgreementResponse);
    },

    /** `POST /v1/me/shop-agreement`: accepts the agreement and rate-card versions the Owner read. */
    async acceptShopAgreement(body: AcceptShopAgreementBody): Promise<ApiResult<ShopAgreementResponse>> {
      return result(await signedIn("POST", "/v1/me/shop-agreement", body), ShopAgreementResponse);
    },

    /** `GET /v1/me/shop-hours`: the Owner's weekly opening hours, empty until first saved (#371). */
    async shopHours(): Promise<ApiResult<ShopHoursResponse>> {
      return result(await signedIn("GET", "/v1/me/shop-hours"), ShopHoursResponse);
    },

    /** `PUT /v1/me/shop-hours`: replaces the whole week. */
    async saveShopHours(body: ShopHours): Promise<ApiResult<ShopHoursResponse>> {
      return result(await signedIn("PUT", "/v1/me/shop-hours", body), ShopHoursResponse);
    },

    /** `GET /v1/me/shop-holidays`: the Owner's holidays, upcoming and ended (#382). */
    async shopHolidays(): Promise<ApiResult<ShopHolidaysResponse>> {
      return result(await signedIn("GET", "/v1/me/shop-holidays"), ShopHolidaysResponse);
    },

    /** `POST /v1/me/shop-holidays`, or `PUT .../:id` with an `id`: saves one holiday and answers the whole list. */
    async saveShopHoliday(body: ShopHoliday, id?: string): Promise<ApiResult<ShopHolidaysResponse>> {
      return result(await (id
        ? signedIn("PUT", `/v1/me/shop-holidays/${encodeURIComponent(id)}`, body)
        : signedIn("POST", "/v1/me/shop-holidays", body)), ShopHolidaysResponse);
    },

    /** `DELETE /v1/me/shop-holidays/:id`: removes a holiday, or ends one under way yesterday. */
    async removeShopHoliday(id: string): Promise<ApiResult<ShopHolidaysResponse>> {
      return result(await signedIn("DELETE", `/v1/me/shop-holidays/${encodeURIComponent(id)}`), ShopHolidaysResponse);
    },

    /** `GET /v1/me/shop-open`: whether the Owner's Live shop is open now, and until when (#380). */
    async shopOpen(): Promise<ApiResult<ShopOpenStatus>> {
      return result(await signedIn("GET", "/v1/me/shop-open"), ShopOpenStatus);
    },

    /** `PUT /v1/me/shop-open`: the Owner's open/closed switch. */
    async setShopOpen(body: ShopOpenChange): Promise<ApiResult<ShopOpenStatus>> {
      return result(await signedIn("PUT", "/v1/me/shop-open", body), ShopOpenStatus);
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
