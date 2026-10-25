import { z } from "zod";
import { AdminActionReason, Email, LoginOtp, PersonName, Phone } from "./fields";

/** An access or refresh token. Capped so a huge body is refused before it is hashed. */
const Token = z.string().min(1).max(512);

/** `POST /v1/auth/code`: email me a sign-in code. Answers 204. */
export const RequestCodeBody = z.strictObject({ email: Email });
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

/** `POST /v1/auth/verify`: the code from the email. Answers a `Session`. */
export const VerifyCodeBody = z.strictObject({ email: Email, code: LoginOtp });
export type VerifyCodeBody = z.infer<typeof VerifyCodeBody>;

/** Provider sign-in (#36). A challenge is bound to one provider and used once. */
export const IdentityProvider = z.enum(["google", "apple"]);
export type IdentityProvider = z.infer<typeof IdentityProvider>;
export const IdentityChallengeBody = z.strictObject({ provider: IdentityProvider });
export type IdentityChallengeBody = z.infer<typeof IdentityChallengeBody>;
export const IdentityChallenge = z.strictObject({ nonce: z.string().regex(/^[a-f0-9]{64}$/) });
export const VerifyIdentityBody = IdentityChallengeBody.extend({
  nonce: IdentityChallenge.shape.nonce,
  identityToken: z.string().min(1).max(8192),
});
export type VerifyIdentityBody = z.infer<typeof VerifyIdentityBody>;
/** A valid Google token for a mailbox Google does not host still needs an emailed code. */
export const IdentityEmailRequired = z.strictObject({ emailVerificationRequired: Email });

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

/** The person's theme: follow the phone's setting, or always Light or Dark (FR-ACC-13). One per account, shared by both mobile apps (#195). */
export const ThemeChoice = z.enum(["system", "light", "dark"]);
export type ThemeChoice = z.infer<typeof ThemeChoice>;

/** `PUT /v1/me/theme`: the account's new theme. Answers the `Account`. */
export const SetThemeBody = z.strictObject({ theme: ThemeChoice });
export type SetThemeBody = z.infer<typeof SetThemeBody>;

/** `POST /v1/admin/accounts`: create an Admin account and record why. Answers 201 with the `Account`. */
export const CreateAdminBody = z.strictObject({
  email: Email,
  name: PersonName,
  phone: Phone,
  reason: AdminActionReason,
});
export type CreateAdminBody = z.infer<typeof CreateAdminBody>;

/**
 * The signed-in account, from `GET /v1/me`. Name and phone are null until the
 * profile is set. `theme` is `system` until the person chooses one. Plain strings, not the field rules: those check what a
 * person types, and a rule made stricter later must not break an account
 * saved under the old one.
 */
export const Account = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  theme: ThemeChoice,
});
export type Account = z.infer<typeof Account>;

/** `GET /v1/admin/accounts`: the Admin accounts. */
export const AdminAccountsResponse = z.strictObject({ accounts: z.array(Account) });
export type AdminAccountsResponse = z.infer<typeof AdminAccountsResponse>;

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

export const IdentitySignInResponse = z.union([Session, IdentityEmailRequired]);
export type IdentitySignInResponse = z.infer<typeof IdentitySignInResponse>;

/**
 * Admin web uses the same session but receives its rotating refresh token in
 * an httpOnly cookie. It must never appear in a browser-readable response.
 */
export const BrowserSession = z.strictObject({
  accessToken: Token,
  account: Account,
});
export type BrowserSession = z.infer<typeof BrowserSession>;
