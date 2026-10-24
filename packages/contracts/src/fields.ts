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
 * (C02, FR-ACC-02; the format SmsSender takes). Accepts what people type or
 * paste: spaces, dashes, dots, brackets, the invisible marks a number copied
 * from Contacts carries, and a leading `0`, `91`, `+91` or `0091`. Letters
 * are kept, so they fail.
 */
export const Phone = z
  .string()
  .overwrite((value) => {
    let digits = value.replace(/[\s\p{Pd}\p{Cf}().]/gu, "");
    if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
    if (digits.startsWith("+91")) return digits;
    if (/^91\d{10}$/.test(digits)) return `+${digits}`;
    if (/^0\d{10}$/.test(digits)) return `+91${digits.slice(1)}`;
    return `+91${digits}`;
  })
  .regex(/^\+91[6-9]\d{9}$/);

/**
 * A person's name, shown to a shop and its deliverer on orders (owner
 * decision on #111). Letters in any script with their marks and the
 * zero-width joiners Indian-language keyboards insert, spaces, and
 * `.` `'` `’` `-`; at least one letter; 1 to 60 characters once trimmed and
 * inner spaces are collapsed. Digits and emoji are refused.
 *
 * Vowel signs, viramas and joiners don't count towards the 60, so a name in
 * an Indian script gets the same room as one in English.
 *
 * To turn away typed junk (owner decision on #111), a name may not hold the
 * same letter three times in a row (`aaa`, any case) or four letters in a
 * row that climb the alphabet one by one (`abcd`, any case; in an Indian
 * script, letters next to each other in Unicode, such as `कखगघ`).
 */
export const PersonName = z
  .string()
  .overwrite((value) => value.normalize("NFC").trim().replace(/\s+/g, " "))
  .min(1)
  .max(240)
  .regex(/^(?:[\p{L}\p{M} .'’-]|\u200C|\u200D)+$/u)
  .regex(/\p{L}/u)
  .refine((value) => [...value.replace(/\p{M}|\u200C|\u200D/gu, "")].length <= 60)
  .refine((value) => !/(\p{L})\1\1/iu.test(value))
  .refine((value) => !climbsFourLetters(value));

/** True when four letters in a row each come one after the last, ignoring case. */
function climbsFourLetters(value: string): boolean {
  let run = 0;
  let last = Number.NaN;
  for (const char of value.toLowerCase()) {
    const point = /\p{L}/u.test(char) ? (char.codePointAt(0) ?? Number.NaN) : Number.NaN;
    run = point === last + 1 ? run + 1 : 1;
    if (run === 4) return true;
    last = point;
  }
  return false;
}

/** An email address, trimmed and lowercased so one inbox is one account (CONTEXT.md, Accounts and sign-in). */
export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** Admin action record reason, trimmed and capped at 500 characters (owner decision on #180). */
export const AdminActionReason = z.string().trim().min(1).max(500);

/** The 6-digit login code (CONTEXT.md, Accounts and sign-in). */
export const LoginOtp = z.string().overwrite(withoutSpaces).regex(/^\d{6}$/);

/** The 4-digit handover code the deliverer enters (CONTEXT.md, Accounts and sign-in). */
export const HandoverOtp = z.string().overwrite(withoutSpaces).regex(/^\d{4}$/);

/** An Indian postal pincode: 6 digits, the first not 0 (DSC-1). */
export const Pincode = z.string().overwrite(withoutSpaces).regex(/^[1-9]\d{5}$/);

/** An Area's name, trimmed, 1 to 100 characters; unique ignoring case on the server (owner decision on #213). */
export const AreaName = z.string().trim().min(1).max(100);

/** "Flat, house or floor" on a saved address, trimmed, 1 to 100 characters (owner decision on #217). */
export const AddressFlat = z.string().trim().min(1).max(100);

/** A saved address's area line, the street and locality the phone's map lookup names; trimmed, 1 to 200 characters (#217). */
export const AddressAreaLine = z.string().trim().min(1).max(200);

/** Master product name, trimmed, 1 to 200 characters (owner decision on #203). */
export const ProductName = z.string().trim().min(1).max(200);

/** Optional master product brand, trimmed, 1 to 100 characters when present (owner decision on #203). */
export const ProductBrand = z.string().trim().min(1).max(100).nullable().optional();

/** Source product image size cap (owner decision on #203). */
export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Base64 product image, capped at the encoded length of PRODUCT_IMAGE_MAX_BYTES (#203). */
export const ProductImage = z.base64().max(Math.ceil(PRODUCT_IMAGE_MAX_BYTES / 3) * 4);

/** Positive base-unit decimal string, NUMERIC(12,3), without binary floats (ADR-0002, owner decision on #205). */
export const PackQuantity = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/).refine((value) => /[1-9]/.test(value));

/** Counted products require a whole base-unit quantity (#205). */
export const CountedPackQuantity = PackQuantity.refine((value) => !/\.\d*[1-9]/.test(value));

/** Optional EAN/UPC digits, compared exactly with leading zeros preserved; no checksum conversion (#205). */
export const PackBarcode = z.string().regex(/^(?:\d{8}|\d{12}|\d{13})$/);

/** A PAN: 5 letters, 4 digits, 1 letter, stored in capitals (ONB-3). */
export const Pan = z
  .string()
  .overwrite((value) => withoutSpaces(value).toUpperCase())
  .regex(/^[A-Z]{5}\d{4}[A-Z]$/);

/** An FSSAI licence or registration number: 14 digits (ONB-3). */
export const FssaiNumber = z.string().overwrite(withoutSpaces).regex(/^\d{14}$/);

/**
 * A UPI id such as `asha.k@okhdfcbank`, stored in lower case (ONB-3). Kept
 * loose on purpose: the payout setup checks the id itself, and a rule
 * stricter than the banks' would block a shop's payouts.
 */
export const UpiId = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^[a-z0-9._-]+@[a-z][a-z0-9.-]*$/);
