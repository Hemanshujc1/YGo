import { z } from "zod";

/**
 * Every field rule, written once. Request schemas build on these, the server
 * checks requests with them and every form checks input with them, so no app
 * keeps its own copy of a rule. A field without a rule here gets one here,
 * citing where the rule was decided.
 *
 * Each schema also cleans what a person types (spaces, case), so a form and
 * the server store the same value.
 */

const withoutSpaces = (value: string) => value.replace(/\s/g, "");

/**
 * An Indian mobile number, sent as `+91` and 10 digits starting 6 to 9
 * (C02, FR-ACC-02; the format SmsSender takes). Accepts what people type:
 * spaces, dashes, brackets, and a leading `0`, `91` or `+91`.
 */
export const Phone = z
  .string()
  .overwrite((value) => {
    const digits = value.replace(/[\s()-]/g, "");
    if (digits.startsWith("+91")) return digits;
    if (/^91\d{10}$/.test(digits)) return `+${digits}`;
    if (/^0\d{10}$/.test(digits)) return `+91${digits.slice(1)}`;
    return `+91${digits}`;
  })
  .regex(/^\+91[6-9]\d{9}$/);

/**
 * A person's name, shown to a shop and its deliverer on orders (owner
 * decision on #111). Letters in any script with their marks, spaces, and
 * `.` `'` `’` `-`; at least one letter; 1 to 60 characters once trimmed and
 * inner spaces are collapsed. Digits and emoji are refused.
 */
export const PersonName = z
  .string()
  .overwrite((value) => value.normalize("NFC").trim().replace(/\s+/g, " "))
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{M} .'’-]+$/u)
  .regex(/\p{L}/u);

/** An email address, trimmed and lowercased so one inbox is one account (CONTEXT.md, Accounts and sign-in). */
export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** The 6-digit login code (CONTEXT.md, Accounts and sign-in). */
export const LoginOtp = z.string().overwrite(withoutSpaces).regex(/^\d{6}$/);

/** The 4-digit handover code the deliverer enters (CONTEXT.md, Accounts and sign-in). */
export const HandoverOtp = z.string().overwrite(withoutSpaces).regex(/^\d{4}$/);

/** An Indian postal pincode: 6 digits, the first not 0 (DSC-1). */
export const Pincode = z.string().overwrite(withoutSpaces).regex(/^[1-9]\d{5}$/);

/** A PAN: 5 letters, 4 digits, 1 letter, stored in capitals (ONB-3). */
export const Pan = z
  .string()
  .overwrite((value) => withoutSpaces(value).toUpperCase())
  .regex(/^[A-Z]{5}\d{4}[A-Z]$/);

/** An FSSAI licence or registration number: 14 digits (ONB-3). */
export const FssaiNumber = z.string().overwrite(withoutSpaces).regex(/^\d{14}$/);

/** A UPI id such as `asha.k@okhdfcbank`, stored in lower case (ONB-3). */
export const UpiId = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/);
