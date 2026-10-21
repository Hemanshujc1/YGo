import {
  ADMIN_REFRESH_HEADER,
  APP_NAME_HEADER,
  APP_VERSION_HEADER,
  ErrorEnvelope,
  type AppIdentity,
  type ErrorCode,
} from "@ygo/contracts";

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

interface ApiFailure {
  ok: false;
  status: number;
  code: ErrorCode;
  fields?: string[];
}

export interface Answer {
  ok: boolean;
  status: number;
  body: unknown;
}

/** A contract schema. Structural, since only @ygo/contracts imports zod. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** What a signed-in call answers, without asking the server, when there is no session. */
export const NO_SESSION: Answer = { ok: false, status: 401, body: { error: { code: "UNAUTHENTICATED" } } };

interface TransportOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  app?: AppIdentity;
  onUpdateRequired?: () => void;
}

interface SendOptions {
  token?: string | null;
  credentials?: RequestCredentials;
  adminRefresh?: boolean;
}

export function createTransport({ baseUrl, fetch: fetchFn, timeoutMs = 10_000, app, onUpdateRequired }: TransportOptions) {
  const origin = baseUrl.trim().replace(/\/+$/, "");

  async function send(method: string, path: string, json?: unknown, options: SendOptions = {}): Promise<Answer> {
    const response = await (fetchFn ?? fetch)(`${origin}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(json !== undefined && { "content-type": "application/json" }),
        ...(options.token && { authorization: `Bearer ${options.token}` }),
        ...(options.adminRefresh && { [ADMIN_REFRESH_HEADER]: "1" }),
        ...(app && { [APP_NAME_HEADER]: app.name, [APP_VERSION_HEADER]: app.version }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      ...(options.credentials && { credentials: options.credentials }),
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

  function result<T>(answer: Answer, schema: Schema<T>): ApiResult<T> {
    if (!answer.ok) return failure(answer.status, answer.body);
    const parsed = schema.safeParse(answer.body);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, status: answer.status, code: "INTERNAL" };
  }

  function empty(answer: Answer): ApiResult<undefined> {
    if (answer.status === 204) return { ok: true, data: undefined };
    return answer.ok
      ? { ok: false, status: answer.status, code: "INTERNAL" }
      : failure(answer.status, answer.body);
  }

  return { send, result, empty };
}
