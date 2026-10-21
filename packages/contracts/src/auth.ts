import { z } from "zod";
import { Email, LoginOtp, PersonName, Phone } from "./fields";

/** An access or refresh token. Capped so a huge body is refused before it is hashed. */
const Token = z.string().min(1).max(512);

/** `POST /v1/auth/code`: email me a sign-in code. Answers 204. */
export const RequestCodeBody = z.strictObject({ email: Email });
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

/** `POST /v1/auth/verify`: the code from the email. Answers a `Session`. */
export const VerifyCodeBody = z.strictObject({ email: Email, code: LoginOtp });
export type VerifyCodeBody = z.infer<typeof VerifyCodeBody>;

/** `POST /v1/auth/refresh`: trade the refresh token for a new pair. Answers a `Session`. */
export const RefreshBody = z.strictObject({ refreshToken: Token });
export type RefreshBody = z.infer<typeof RefreshBody>;

/**
 * `PUT /v1/me/profile`: the name and phone every account gives once, before
 * anything else (ACC-2). The phone is stored as unverified (ACC-3, D-16).
 * Answers the `Account`.
 */
export const SetProfileBody = z.strictObject({ name: PersonName, phone: Phone });
export type SetProfileBody = z.infer<typeof SetProfileBody>;

/** `PATCH /v1/me`: a new name. Email and phone change only through support (ACC-2). Answers the `Account`. */
export const ChangeNameBody = z.strictObject({ name: PersonName });
export type ChangeNameBody = z.infer<typeof ChangeNameBody>;

/** `POST /v1/admin/accounts`: create an Admin account and record why. */
export const CreateAdminBody = z.strictObject({
  email: Email,
  name: PersonName,
  phone: Phone,
  reason: z.string().trim().min(1),
});
export type CreateAdminBody = z.infer<typeof CreateAdminBody>;

/**
 * The signed-in account, from `GET /v1/me`. Name and phone are null until the
 * profile is set. Plain strings, not the field rules: those check what a
 * person types, and a rule made stricter later must not break an account
 * saved under the old one.
 */
export const Account = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
});
export type Account = z.infer<typeof Account>;

/**
 * A signed-in session (#34). The access token is short-lived and kept in
 * memory; the refresh token goes to the phone's secure storage and is
 * replaced on every refresh.
 */
export const Session = z.object({
  accessToken: Token,
  refreshToken: Token,
  account: Account,
});
export type Session = z.infer<typeof Session>;

/**
 * Admin web uses the same session but receives its rotating refresh token in
 * an httpOnly cookie. It must never appear in a browser-readable response.
 */
export const BrowserSession = z.strictObject({
  accessToken: Token,
  account: Account,
});
export type BrowserSession = z.infer<typeof BrowserSession>;
