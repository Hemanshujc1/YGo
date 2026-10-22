import {
  Account,
  AdminAccountsResponse,
  Area,
  AreasResponse,
  BrowserSession,
  CategoriesResponse,
  Category,
  type CreateAdminBody,
  type CreateAreaBody,
  type CreateCategoryBody,
  type EditAreaBody,
  type EditCategoryBody,
  type RequestCodeBody,
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

  async function adminRequest(method: string, path: string, json?: CreateAdminBody | CreateCategoryBody | EditCategoryBody | CreateAreaBody | EditAreaBody): Promise<Answer> {
    const on = current;
    if (on.ended) return NO_SESSION;
    const renewedFirst = !on.access || on.renewing !== null;
    if (renewedFirst) {
      const refused = await renew(on, on.access);
      if (refused) return refused;
    }
    if (on !== current || on.ended || !on.access) return NO_SESSION;
    const token = on.access;
    const answer = await send(method, path, json, { token });
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
    const retried = await send(method, path, json, { token: on.access });
    if (on !== current || on.ended) return NO_SESSION;
    if (retried.status === 401 || retried.status === 403) end(on);
    return retried;
  }

  return {
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

    /** `GET /v1/admin/accounts`: Admin memberships and their accounts. */
    async listAccounts(): Promise<ApiResult<AdminAccountsResponse>> {
      return result(await adminRequest("GET", "/v1/admin/accounts"), AdminAccountsResponse);
    },

    /** `POST /v1/admin/accounts`: create an Admin with a recorded reason. */
    async createAccount(body: CreateAdminBody): Promise<ApiResult<Account>> {
      return result(await adminRequest("POST", "/v1/admin/accounts", body), Account);
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
