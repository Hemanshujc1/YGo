import {
  Account,
  AdminAccount,
  type AdminRole,
  CATALOG_IMPORT_FILE_FIELDS,
  CatalogImportPreviewResponse,
  CatalogImportResponse,
  type CatalogImportFileField,
  AdminAccountsResponse,
  Area,
  AreasResponse,
  BrowserSession,
  WaitlistResponse,
  RateCardScopeQuery,
  ScopedRateCardResponse,
  RateCardResponse,
  PublishedRateCardResponse,
  PriceSimulatorResponse,
  CouponResponse,
  CouponsResponse,
  type AdminCouponBody,
  SimulatorListingsResponse,
  type PriceSimulatorBody,
  CategoriesResponse,
  Category,
  SearchTerm,
  SearchTermsResponse,
  type SearchTermBody,
  DenylistWordBody,
  DenylistWordsResponse,
  MasterProduct,
  MasterProductsResponse,
  Pack,
  PacksResponse,
  AdminShopApplication,
  LiveCheck,
  AdminProductRequest,
  AdminProductRequestsResponse,
  type MapProductRequestBody,
  type RejectProductRequestBody,
  ProofException,
  ProofExceptionPhotoAccess,
  ProofExceptionsResponse,
  ShopApplicationsResponse,
  ShopVisit,
  ShopOnboarding,
  AdminCounterBill,
  AdminCounterBillsResponse,
  type ResolveCounterBillBody,
  AdminFlaggedQuantityOption,
  AdminFlaggedQuantityOptionsResponse,
  type DismissFlaggedQuantityOptionBody,
  OnboardingFee,
  BelowFloorException,
  BelowFloorExceptionsResponse,
  AdminOrderDetail,
  AdminOrdersResponse,
  type AdminOrderGroup,
  type ForceTransitionBody,
  type ForceFulfilmentModeBody,
  type FulfilmentMode,
  FulfilmentModesResponse,
  VisitPhotoUpload,
  VisitPhotoAccess,
  type CreateVisitPhotoUploadBody,
  type RecordShopVisitBody,
  type RecordOnboardingFeeBody,
  type AssignShopAreaManagerBody,
  type CorrectShopApplicationBody,
  type CreateAdminBody,
  type PublishRateCardBody,
  type RateCardScope,
  type ResolveRateCardQuery,
  type CreateAreaBody,
  type CreateCategoryBody,
  type CreateMasterProductBody,
  type EditAreaBody,
  type EditCategoryBody,
  type EditMasterProductBody,
  type CreatePackBody,
  type EditPackBody,
  type RequestCodeBody,
  type SetThemeBody,
  type VerifyCodeBody,
} from "@ygo/contracts";
import { createTransport, NO_SESSION, type Answer, type ApiResult } from "./transport";

export interface AdminApiClientOptions {
  /** The API origin, or `""` when `/v1` is served on the Admin page's origin. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Called when the server refuses refresh or an Admin request ends the session. */
  onSignedOut?: () => void;
}

interface AdminLife {
  access: string | null;
  renewing: Promise<Answer | null> | null;
  ended: boolean;
  /** Read once from `/v1/admin/me` for this sign-in; gone with it. */
  role: AdminRole | null;
}

const life = (access: string | null, ended = false): AdminLife => ({ access, renewing: null, ended, role: null });

/** Admin's refresh token stays in the browser's httpOnly cookie, outside this client. */
export function createAdminApiClient({ baseUrl, fetch, timeoutMs, onSignedOut }: AdminApiClientOptions) {
  const { send, result, empty } = createTransport({ baseUrl, fetch, timeoutMs });
  let current = life(null);

  function end(on: AdminLife): void {
    if (on.ended) return;
    on.ended = true;
    on.access = null;
    if (on === current) onSignedOut?.();
  }

  async function refresh(on: AdminLife): Promise<Answer | null> {
    const answer = await send("POST", "/v1/admin/auth/refresh", undefined, {
      credentials: "include",
      adminRefresh: true,
    });
    if (on !== current || on.ended) return NO_SESSION;
    if (answer.ok) {
      const session = BrowserSession.safeParse(answer.body);
      if (!session.success) return { ok: false, status: answer.status, body: undefined };
      on.access = session.data.accessToken;
      return null;
    }
    if (answer.status === 401 || answer.status === 403) end(on);
    return answer;
  }

  /** Calls waiting for the same new access token share one cookie rotation. */
  function renew(on: AdminLife, refused: string | null): Promise<Answer | null> {
    if (on.ended || on !== current) return Promise.resolve(NO_SESSION);
    if (on.access !== refused) return Promise.resolve(null);
    on.renewing ??= refresh(on).finally(() => {
      on.renewing = null;
    });
    return on.renewing;
  }

  async function adminRequest(method: string, path: string, json?: CreateAdminBody | CreateCategoryBody | EditCategoryBody | SearchTermBody | DenylistWordBody | CreateAreaBody | EditAreaBody | CreateMasterProductBody | EditMasterProductBody | CreatePackBody | EditPackBody | CorrectShopApplicationBody | AssignShopAreaManagerBody | SetThemeBody | PriceSimulatorBody | CreateVisitPhotoUploadBody | RecordShopVisitBody | RecordOnboardingFeeBody | ResolveCounterBillBody | MapProductRequestBody | RejectProductRequestBody | ForceFulfilmentModeBody | FormData, requestTimeoutMs?: number): Promise<Answer> {
    const on = current;
    if (on.ended) return NO_SESSION;
    const renewedFirst = !on.access || on.renewing !== null;
    if (renewedFirst) {
      const refused = await renew(on, on.access);
      if (refused) return refused;
    }
    if (on !== current || on.ended || !on.access) return NO_SESSION;
    const token = on.access;
    const answer = await send(method, path, json, { token, timeoutMs: requestTimeoutMs });
    if (on !== current || on.ended) return NO_SESSION;
    if (answer.status === 403) {
      end(on);
      return answer;
    }
    if (answer.status !== 401) return answer;
    if (renewedFirst) {
      end(on);
      return answer;
    }
    const refused = await renew(on, token);
    if (refused) return refused;
    if (on !== current || on.ended || !on.access) return NO_SESSION;
    const retried = await send(method, path, json, { token: on.access, timeoutMs: requestTimeoutMs });
    if (on !== current || on.ended) return NO_SESSION;
    if (retried.status === 401 || retried.status === 403) end(on);
    return retried;
  }

  async function me(): Promise<ApiResult<AdminAccount>> {
    const on = current;
    const answered = result(await adminRequest("GET", "/v1/admin/me"), AdminAccount);
    if (answered.ok && on === current && !on.ended) on.role = answered.data.role;
    return answered;
  }

  function importFiles(files: Record<CatalogImportFileField, File>): FormData {
    const body = new FormData();
    for (const field of CATALOG_IMPORT_FILE_FIELDS) body.append(field, files[field]);
    return body;
  }

  return {
    /** Validate the CSV and companion ZIP; each upload request allows five minutes. */
    async previewCatalogImport(files: Record<CatalogImportFileField, File>): Promise<ApiResult<CatalogImportPreviewResponse>> {
      return result(await adminRequest("POST", "/v1/admin/catalog/import/preview", importFiles(files), 300_000), CatalogImportPreviewResponse);
    },

    /** Revalidate and atomically import the same files; row errors remain available on failure. */
    async commitCatalogImport(files: Record<CatalogImportFileField, File>): Promise<ApiResult<CatalogImportResponse>> {
      return result(await adminRequest("POST", "/v1/admin/catalog/import/commit", importFiles(files), 300_000), CatalogImportResponse);
    },

    /** GET /v1/admin/waitlist: saved callback numbers for expansion planning. */
    async listWaitlist(): Promise<ApiResult<WaitlistResponse>> {
      return result(await adminRequest("GET", "/v1/admin/waitlist"), WaitlistResponse);
    },
    /** `POST /v1/admin/auth/code`: answers the same for Admin and non-Admin email. */
    async requestCode(body: RequestCodeBody): Promise<ApiResult<undefined>> {
      return empty(await send("POST", "/v1/admin/auth/code", body, { credentials: "include" }));
    },

    /** `POST /v1/admin/auth/verify`: keep only the access token in memory. */
    async verifyCode(body: VerifyCodeBody): Promise<ApiResult<Account>> {
      const started = current;
      const answered = result(await send("POST", "/v1/admin/auth/verify", body, { credentials: "include" }), BrowserSession);
      if (!answered.ok) return answered;
      if (current !== started) return { ok: false, status: 401, code: "UNAUTHENTICATED" };
      started.ended = true;
      current = life(answered.data.accessToken);
      return { ok: true, data: answered.data.account };
    },

    /** `GET /v1/admin/me`: the signed-in Admin's or Area Manager's own account, with theme and role (#343). */
    me,
    /** The signed-in role, asking the server only the first time in a sign-in (#343). */
    async role(): Promise<ApiResult<AdminRole>> {
      if (current.role) return { ok: true, data: current.role };
      const answered = await me();
      return answered.ok ? { ok: true, data: answered.data.role } : answered;
    },
    /** The role read in this sign-in, or null before the first read and after the session ends. */
    currentRole(): AdminRole | null {
      return current.ended ? null : current.role;
    },

    /** `PUT /v1/admin/me/theme`: save the theme on the account, shared with the mobile apps (#263). */
    async setTheme(body: SetThemeBody): Promise<ApiResult<Account>> {
      return result(await adminRequest("PUT", "/v1/admin/me/theme", body), Account);
    },

    /** `GET /v1/admin/accounts`: Admin and Area Manager accounts, each with its role. */
    async listAccounts(): Promise<ApiResult<AdminAccountsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/accounts"), AdminAccountsResponse);
    },

    /** `POST /v1/admin/accounts`: create an Admin or Area Manager with a recorded reason. */
    async createAccount(body: CreateAdminBody): Promise<ApiResult<AdminAccount>> {
      return result(await adminRequest("POST", "/v1/admin/accounts", body), AdminAccount);
    },

    /** `GET /v1/admin/categories`: list the global category tree. */
    async listCategories(): Promise<ApiResult<CategoriesResponse>> {
      return result(await adminRequest("GET", "/v1/admin/categories"), CategoriesResponse);
    },
    /** Latest complete card published at an exact scope; global has no id. */
    async getRateCardScope(scope: RateCardScope, version?: string): Promise<ApiResult<ScopedRateCardResponse>> {
      const query = new URLSearchParams({ type: scope.type });
      if ("id" in scope) query.set("id", scope.id);
      if (version) query.set("version", version);
      const parsed = RateCardScopeQuery.safeParse({ ...scope, ...(version ? { version } : {}) });
      if (!parsed.success) return { ok: false, status: 400, code: "VALIDATION_FAILED" };
      return result(await adminRequest("GET", `/v1/admin/rate-cards/scope?${query}`), ScopedRateCardResponse);
    },
    /** Preview inheritance and source at a shop/category context. */
    async getEffectiveRateCard(query: ResolveRateCardQuery): Promise<ApiResult<RateCardResponse>> {
      const params = new URLSearchParams({ shopId: query.shopId });
      if (query.categoryId) params.set("categoryId", query.categoryId);
      if (query.usesPickup) params.set("usesPickup", "true");
      if (query.usesBargain) params.set("usesBargain", "true");
      if (query.version) params.set("version", String(query.version));
      return result(await adminRequest("GET", `/v1/admin/rate-cards/effective?${params}`), RateCardResponse);
    },
    /** Explicit whole-card publication; every call creates an immutable version. */
    async publishRateCard(body: PublishRateCardBody): Promise<ApiResult<PublishedRateCardResponse>> {
      return result(await adminRequest("POST", "/v1/admin/rate-cards/publish", body), PublishedRateCardResponse);
    },

    /** `GET /v1/admin/shops/:id/listings`: the packs and quantity-price options a simulated basket can hold. */
    async listSimulatorListings(shopId: string): Promise<ApiResult<SimulatorListingsResponse>> {
      return result(await adminRequest("GET", `/v1/admin/shops/${encodeURIComponent(shopId)}/listings`), SimulatorListingsResponse);
    },
    /** `POST /v1/admin/price-simulator`: price a basket now, and under an unsaved draft rule when one is given. */
    async simulatePrice(body: PriceSimulatorBody): Promise<ApiResult<PriceSimulatorResponse>> {
      return result(await adminRequest("POST", "/v1/admin/price-simulator", body), PriceSimulatorResponse);
    },

    /** `GET /v1/admin/coupons`: every coupon, whoever pays for it, with the orders it is in force on (ADM-5). */
    async listCoupons(): Promise<ApiResult<CouponsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/coupons"), CouponsResponse);
    },
    /** `POST /v1/admin/coupons`: a platform-funded coupon, or a shop-funded one for a named shop. */
    async createCoupon(body: AdminCouponBody): Promise<ApiResult<CouponResponse>> {
      return result(await adminRequest("POST", "/v1/admin/coupons", body), CouponResponse);
    },
    /** `PUT /v1/admin/coupons/:id`: change a coupon's terms or turn it on or off; every save keeps a version. */
    async updateCoupon(id: string, body: AdminCouponBody): Promise<ApiResult<CouponResponse>> {
      return result(await adminRequest("PUT", `/v1/admin/coupons/${encodeURIComponent(id)}`, body), CouponResponse);
    },

    /** `POST /v1/admin/categories`: create a top-level or child category. */
    async createCategory(body: CreateCategoryBody): Promise<ApiResult<Category>> {
      return result(await adminRequest("POST", "/v1/admin/categories", body), Category);
    },

    /** `PATCH /v1/admin/categories/:id`: edit or change a category's active setting. */
    async editCategory(id: string, body: EditCategoryBody): Promise<ApiResult<Category>> {
      return result(await adminRequest("PATCH", `/v1/admin/categories/${encodeURIComponent(id)}`, body), Category);
    },

    /** `GET /v1/admin/search-terms`: the platform's search terms (#397). */
    async listSearchTerms(): Promise<ApiResult<SearchTermsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/search-terms"), SearchTermsResponse);
    },

    /** `POST /v1/admin/search-terms`: add a typed word and the catalog word it means. */
    async createSearchTerm(body: SearchTermBody): Promise<ApiResult<SearchTerm>> {
      return result(await adminRequest("POST", "/v1/admin/search-terms", body), SearchTerm);
    },

    /** `PUT /v1/admin/search-terms/:id`: change either word of a term. */
    async editSearchTerm(id: string, body: SearchTermBody): Promise<ApiResult<SearchTerm>> {
      return result(await adminRequest("PUT", `/v1/admin/search-terms/${encodeURIComponent(id)}`, body), SearchTerm);
    },

    /** `DELETE /v1/admin/search-terms/:id`: remove a term. */
    async removeSearchTerm(id: string): Promise<ApiResult<undefined>> {
      return empty(await adminRequest("DELETE", `/v1/admin/search-terms/${encodeURIComponent(id)}`));
    },

    /** `GET /v1/admin/denylist-words`: excluded-goods words and phrases (CAT-8, ADM-3, #69). */
    async listDenylistWords(): Promise<ApiResult<DenylistWordsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/denylist-words"), DenylistWordsResponse);
    },

    /** `POST /v1/admin/denylist-words`: add a denylist word or phrase. */
    async createDenylistWord(body: DenylistWordBody): Promise<ApiResult<DenylistWordBody>> {
      return result(await adminRequest("POST", "/v1/admin/denylist-words", body), DenylistWordBody);
    },

    /** `DELETE /v1/admin/denylist-words/:word`: remove a denylist word. */
    async removeDenylistWord(word: string): Promise<ApiResult<undefined>> {
      return empty(await adminRequest("DELETE", `/v1/admin/denylist-words/${encodeURIComponent(word)}`));
    },

    /** GET /v1/admin/products: the global master-product catalog. */
    async listMasterProducts(): Promise<ApiResult<MasterProductsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/products"), MasterProductsResponse);
    },

    /** POST /v1/admin/products: create and publish a master product with its image. */
    async createMasterProduct(body: CreateMasterProductBody): Promise<ApiResult<MasterProduct>> {
      return result(await adminRequest("POST", "/v1/admin/products", body), MasterProduct);
    },

    /** PATCH /v1/admin/products/:id: edit, replace the image, or change active state. */
    async editMasterProduct(id: string, body: EditMasterProductBody): Promise<ApiResult<MasterProduct>> {
      return result(await adminRequest("PATCH", `/v1/admin/products/${encodeURIComponent(id)}`, body), MasterProduct);
    },

    async listPacks(productId: string): Promise<ApiResult<PacksResponse>> {
      return result(await adminRequest("GET", `/v1/admin/products/${encodeURIComponent(productId)}/packs`), PacksResponse);
    },

    async createPack(productId: string, body: CreatePackBody): Promise<ApiResult<Pack>> {
      return result(await adminRequest("POST", `/v1/admin/products/${encodeURIComponent(productId)}/packs`, body), Pack);
    },

    async editPack(productId: string, id: string, body: EditPackBody): Promise<ApiResult<Pack>> {
      return result(await adminRequest("PATCH", `/v1/admin/products/${encodeURIComponent(productId)}/packs/${encodeURIComponent(id)}`, body), Pack);
    },

    /** `GET /v1/admin/areas`: every Area with its pincodes. */
    async listAreas(): Promise<ApiResult<AreasResponse>> {
      return result(await adminRequest("GET", "/v1/admin/areas"), AreasResponse);
    },

    /** `POST /v1/admin/areas`: a new Area; a pincode another Area holds answers PINCODE_IN_OTHER_AREA. */
    async createArea(body: CreateAreaBody): Promise<ApiResult<Area>> {
      return result(await adminRequest("POST", "/v1/admin/areas", body), Area);
    },

    /** `PATCH /v1/admin/areas/:id`: new pincodes, or pause / resume, with a reason. */
    async editArea(id: string, body: EditAreaBody): Promise<ApiResult<Area>> {
      return result(await adminRequest("PATCH", `/v1/admin/areas/${encodeURIComponent(id)}`, body), Area);
    },

    /** `GET /v1/admin/proof-exceptions`: A28, one page of Open or Reviewed proof exceptions with the per-shop and per-deliverer counts (DLV-4). */
    async listProofExceptions(query: { status?: "open" | "reviewed"; shopId?: string; delivererId?: string; limit?: number; cursor?: string } = {}): Promise<ApiResult<ProofExceptionsResponse>> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return result(await adminRequest("GET", `/v1/admin/proof-exceptions?${params}`), ProofExceptionsResponse);
    },

    /** `GET /v1/admin/product-requests`: A11, the requests waiting for Admin, or the answered ones (CAT-3). */
    async listProductRequests(status: "pending" | "resolved" = "pending"): Promise<ApiResult<AdminProductRequestsResponse>> {
      return result(await adminRequest("GET", `/v1/admin/product-requests?status=${status}`), AdminProductRequestsResponse);
    },

    /** `POST /v1/admin/product-requests/:id/approve`: publishes the product. 409 `PRODUCT_IMAGE_REQUIRED` until its images are added on the product. */
    async approveProductRequest(id: string): Promise<ApiResult<AdminProductRequest>> {
      return result(await adminRequest("POST", `/v1/admin/product-requests/${encodeURIComponent(id)}/approve`), AdminProductRequest);
    },

    /** `POST /v1/admin/product-requests/:id/map`: points the shop at an existing catalog pack and moves its stock. 409 `PACK_ALREADY_LISTED` when the shop lists that pack. */
    async mapProductRequest(id: string, packId: string): Promise<ApiResult<AdminProductRequest>> {
      return result(await adminRequest("POST", `/v1/admin/product-requests/${encodeURIComponent(id)}/map`, { packId } satisfies MapProductRequestBody), AdminProductRequest);
    },

    /** `POST /v1/admin/product-requests/:id/reject`: with a reason; `excludedGood` also takes the product off the shop's counter list (D-9). */
    async rejectProductRequest(id: string, body: RejectProductRequestBody): Promise<ApiResult<AdminProductRequest>> {
      return result(await adminRequest("POST", `/v1/admin/product-requests/${encodeURIComponent(id)}/reject`, body), AdminProductRequest);
    },

    /** `GET /v1/admin/shops/:id/fulfilment-modes`: one shop's modes with its own switch and Admin's force-off (FUL-1, #65). */
    async shopFulfilmentModes(shopId: string): Promise<ApiResult<FulfilmentModesResponse>> {
      return result(await adminRequest("GET", `/v1/admin/shops/${encodeURIComponent(shopId)}/fulfilment-modes`), FulfilmentModesResponse);
    },

    /** `PUT /v1/admin/shops/:id/fulfilment-modes/:mode`: forces a mode off or lifts it; the shop's own switch is not changed (#65). */
    async forceFulfilmentMode(shopId: string, mode: FulfilmentMode, forcedOff: boolean): Promise<ApiResult<FulfilmentModesResponse>> {
      return result(await adminRequest("PUT", `/v1/admin/shops/${encodeURIComponent(shopId)}/fulfilment-modes/${mode}`, { forcedOff }), FulfilmentModesResponse);
    },

    /** `GET /v1/admin/orders`: A14, one page of orders newest first with counts and the server's clock (ADM-4, ADM-7, #66). An Area Manager gets only their shops. */
    async listAdminOrders(query: { group?: AdminOrderGroup; shopId?: string; limit?: number; cursor?: string } = {}): Promise<ApiResult<AdminOrdersResponse>> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return result(await adminRequest("GET", `/v1/admin/orders?${params}`), AdminOrdersResponse);
    },

    /** `GET /v1/admin/orders/:id`: A15, one order with its frozen lines and money, timeline and the moves Admin may force. */
    async getAdminOrder(id: string): Promise<ApiResult<AdminOrderDetail>> {
      return result(await adminRequest("GET", `/v1/admin/orders/${encodeURIComponent(id)}`), AdminOrderDetail);
    },

    /** `POST /v1/admin/orders/:id/force-transition`: Admin only; ORDER_STATUS_CHANGED when the order moved since it was shown (ADM-4, ORD-1). */
    async forceOrderTransition(id: string, body: ForceTransitionBody): Promise<ApiResult<AdminOrderDetail>> {
      return result(await adminRequest("POST", `/v1/admin/orders/${encodeURIComponent(id)}/force-transition`, body), AdminOrderDetail);
    },

    /** `GET /v1/admin/orders/below-floor-exceptions`: A30, one page of Open or Reviewed below-floor contribution exceptions with shop counts (MNY-4, ADM-7). */
    async listBelowFloorExceptions(query: { status?: "open" | "reviewed"; shopId?: string; areaManagerId?: string; limit?: number; cursor?: string } = {}): Promise<ApiResult<BelowFloorExceptionsResponse>> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return result(await adminRequest("GET", `/v1/admin/orders/below-floor-exceptions?${params}`), BelowFloorExceptionsResponse);
    },

    /** `POST /v1/admin/orders/below-floor-exceptions/:revisionId/review`: mark one reviewed; marking it again changes nothing. */
    async reviewBelowFloorException(revisionId: string): Promise<ApiResult<BelowFloorException>> {
      return result(await adminRequest("POST", `/v1/admin/orders/below-floor-exceptions/${encodeURIComponent(revisionId)}/review`), BelowFloorException);
    },

    /** `POST /v1/admin/proof-exceptions/:orderId/review`: mark one reviewed; marking it again changes nothing. */
    async reviewProofException(orderId: string): Promise<ApiResult<ProofException>> {
      return result(await adminRequest("POST", `/v1/admin/proof-exceptions/${encodeURIComponent(orderId)}/review`), ProofException);
    },

    /** `GET /v1/admin/proof-exceptions/:orderId/photo`: a private link to the proof photo, good for 5 minutes. 404 `PHOTO_EXPIRED` once it is removed (#560). */
    async getProofExceptionPhoto(orderId: string): Promise<ApiResult<ProofExceptionPhotoAccess>> {
      return result(await adminRequest("GET", `/v1/admin/proof-exceptions/${encodeURIComponent(orderId)}/photo`), ProofExceptionPhotoAccess);
    },

    /** `GET /v1/admin/shop-applications`: sent applications, the longest waiting first (A06). */
    async listShopApplications(): Promise<ApiResult<ShopApplicationsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/shop-applications"), ShopApplicationsResponse);
    },

    /** `GET /v1/admin/shop-applications/:id` (A07). */
    async getShopApplication(id: string): Promise<ApiResult<AdminShopApplication>> {
      return result(await adminRequest("GET", `/v1/admin/shop-applications/${encodeURIComponent(id)}`), AdminShopApplication);
    },

    /** `PATCH /v1/admin/shop-applications/:id`: correct fields with a reason. */
    async correctShopApplication(id: string, body: CorrectShopApplicationBody): Promise<ApiResult<AdminShopApplication>> {
      return result(await adminRequest("PATCH", `/v1/admin/shop-applications/${encodeURIComponent(id)}`, body), AdminShopApplication);
    },

    /** `PUT /v1/admin/shop-applications/:id/area-manager`: assign, move or take back (null) with a reason (#299). */
    async assignShopAreaManager(id: string, body: AssignShopAreaManagerBody): Promise<ApiResult<AdminShopApplication>> {
      return result(await adminRequest("PUT", `/v1/admin/shop-applications/${encodeURIComponent(id)}/area-manager`, body), AdminShopApplication);
    },

    /** `POST /v1/admin/shop-applications/:id/start-review`: Submitted to Under Review. */
    async startShopApplicationReview(id: string): Promise<ApiResult<AdminShopApplication>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/start-review`), AdminShopApplication);
    },

    /** `POST /v1/admin/shop-applications/:id/approve`: Under Review to Approved. */
    async approveShopApplication(id: string): Promise<ApiResult<AdminShopApplication>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/approve`), AdminShopApplication);
    },

    /** `GET /v1/admin/shop-applications/:id/live-check`: what still blocks Live (#363). */
    async shopLiveCheck(id: string): Promise<ApiResult<LiveCheck>> {
      return result(await adminRequest("GET", `/v1/admin/shop-applications/${encodeURIComponent(id)}/live-check`), LiveCheck);
    },

    /** `POST /v1/admin/shop-applications/:id/go-live`: Approved to Live; SHOP_NOT_READY carries the blockers (#363). */
    async moveShopToLive(id: string): Promise<ApiResult<AdminShopApplication>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/go-live`), AdminShopApplication);
    },

    /** Issue a private PUT URL from the authenticated API; never substitute an input URL. */
    async createVisitPhotoUpload(id: string, body: CreateVisitPhotoUploadBody): Promise<ApiResult<VisitPhotoUpload>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/visit-photo-upload`, body), VisitPhotoUpload);
    },

    /** Record a visit using the server-issued upload id; the server reads GPS from the photo. */
    async recordShopVisit(id: string, body: RecordShopVisitBody): Promise<ApiResult<ShopVisit>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/visits`, body), ShopVisit);
    },

    /** Issue fresh private GET access from the authenticated API; URL syntax alone establishes no trust. */
    async getVisitPhotoAccess(id: string, visitId: string): Promise<ApiResult<VisitPhotoAccess>> {
      return result(await adminRequest("GET", `/v1/admin/shop-applications/${encodeURIComponent(id)}/visits/${encodeURIComponent(visitId)}/photo`), VisitPhotoAccess);
    },

    /** Append a paid fee or reasoned waiver, preserving earlier entries. */
    async recordOnboardingFee(id: string, body: RecordOnboardingFeeBody): Promise<ApiResult<OnboardingFee>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/onboarding-fees`, body), OnboardingFee);
    },

    /** A shop's held and flagged counter bills, and the ones Admin has dealt with (#470). Admin only. */
    async listCounterBills(shopId: string): Promise<ApiResult<AdminCounterBillsResponse>> {
      return result(await adminRequest("GET", `/v1/admin/shops/${encodeURIComponent(shopId)}/counter-bills`), AdminCounterBillsResponse);
    },

    /** Number, close, review or add a note to one held or flagged bill; the bill comes back as it now stands (#470). */
    async resolveCounterBill(shopId: string, billId: string, body: ResolveCounterBillBody): Promise<ApiResult<AdminCounterBill>> {
      return result(await adminRequest("POST", `/v1/admin/shops/${encodeURIComponent(shopId)}/counter-bills/${encodeURIComponent(billId)}/resolutions`, body), AdminCounterBill);
    },

    /** A shop's denylist-flagged quantity-price options (CAT-8, #621). */
    async listFlaggedQuantityOptions(shopId: string): Promise<ApiResult<AdminFlaggedQuantityOptionsResponse>> {
      return result(await adminRequest("GET", `/v1/admin/shops/${encodeURIComponent(shopId)}/flagged-quantity-options`), AdminFlaggedQuantityOptionsResponse);
    },

    /** Dismiss the denylist flag on a quantity-price option (CAT-8, #621). */
    async dismissFlaggedQuantityOption(shopId: string, optionId: string, body: DismissFlaggedQuantityOptionBody): Promise<ApiResult<AdminFlaggedQuantityOption>> {
      return result(await adminRequest("POST", `/v1/admin/shops/${encodeURIComponent(shopId)}/flagged-quantity-options/${encodeURIComponent(optionId)}/dismiss`, body), AdminFlaggedQuantityOption);
    },

    /** Read visit and fee histories, newest first, with the owner's contact confirmation state. */
    async getShopOnboarding(id: string): Promise<ApiResult<ShopOnboarding>> {
      return result(await adminRequest("GET", `/v1/admin/shop-applications/${encodeURIComponent(id)}/onboarding`), ShopOnboarding);
    },

    /** Clear local access immediately and ask the server to end the cookie session. */
    async signOut(): Promise<ApiResult<undefined>> {
      const ending = current;
      current = life(null, true);
      if (ending.renewing) await ending.renewing.catch(() => null);
      const answer = await send("POST", "/v1/admin/auth/sign-out", undefined, {
        credentials: "include",
        adminRefresh: true,
      });
      return answer.status === 401 ? { ok: true, data: undefined } : empty(answer);
    },
  };
}
