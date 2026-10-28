import {
  Account,
  AdminAccount,
  CATALOG_IMPORT_FILE_FIELDS,
  CatalogImportPreviewResponse,
  CatalogImportResponse,
  type CatalogImportFileField,
  AdminAccountsResponse,
  Area,
  AreasResponse,
  BrowserSession,
  WaitlistResponse,
  CategoriesResponse,
  Category,
  MasterProduct,
  MasterProductsResponse,
  Pack,
  PacksResponse,
  ShopApplication,
  ShopApplicationsResponse,
  ShopVisit,
  ShopOnboarding,
  OnboardingFee,
  VisitPhotoUpload,
  VisitPhotoAccess,
  type CreateVisitPhotoUploadBody,
  type RecordShopVisitBody,
  type RecordOnboardingFeeBody,
  type CorrectShopApplicationBody,
  type CreateAdminBody,
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
}

const life = (access: string | null, ended = false): AdminLife => ({ access, renewing: null, ended });

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

  async function adminRequest(method: string, path: string, json?: CreateAdminBody | CreateCategoryBody | EditCategoryBody | CreateAreaBody | EditAreaBody | CreateMasterProductBody | EditMasterProductBody | CreatePackBody | EditPackBody | CorrectShopApplicationBody | SetThemeBody | CreateVisitPhotoUploadBody | RecordShopVisitBody | RecordOnboardingFeeBody | FormData, requestTimeoutMs?: number): Promise<Answer> {
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
    async me(): Promise<ApiResult<AdminAccount>> {
      return result(await adminRequest("GET", "/v1/admin/me"), AdminAccount);
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

    /** `POST /v1/admin/categories`: create a top-level or child category. */
    async createCategory(body: CreateCategoryBody): Promise<ApiResult<Category>> {
      return result(await adminRequest("POST", "/v1/admin/categories", body), Category);
    },

    /** `PATCH /v1/admin/categories/:id`: edit or change a category's active setting. */
    async editCategory(id: string, body: EditCategoryBody): Promise<ApiResult<Category>> {
      return result(await adminRequest("PATCH", `/v1/admin/categories/${encodeURIComponent(id)}`, body), Category);
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

    /** `GET /v1/admin/shop-applications`: sent applications, the longest waiting first (A06). */
    async listShopApplications(): Promise<ApiResult<ShopApplicationsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/shop-applications"), ShopApplicationsResponse);
    },

    /** `GET /v1/admin/shop-applications/:id` (A07). */
    async getShopApplication(id: string): Promise<ApiResult<ShopApplication>> {
      return result(await adminRequest("GET", `/v1/admin/shop-applications/${encodeURIComponent(id)}`), ShopApplication);
    },

    /** `PATCH /v1/admin/shop-applications/:id`: correct fields with a reason. */
    async correctShopApplication(id: string, body: CorrectShopApplicationBody): Promise<ApiResult<ShopApplication>> {
      return result(await adminRequest("PATCH", `/v1/admin/shop-applications/${encodeURIComponent(id)}`, body), ShopApplication);
    },

    /** `POST /v1/admin/shop-applications/:id/start-review`: Submitted to Under Review. */
    async startShopApplicationReview(id: string): Promise<ApiResult<ShopApplication>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/start-review`), ShopApplication);
    },

    /** `POST /v1/admin/shop-applications/:id/approve`: Under Review to Approved. */
    async approveShopApplication(id: string): Promise<ApiResult<ShopApplication>> {
      return result(await adminRequest("POST", `/v1/admin/shop-applications/${encodeURIComponent(id)}/approve`), ShopApplication);
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
