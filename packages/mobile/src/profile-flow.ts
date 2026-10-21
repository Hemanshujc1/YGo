import type { ApiResult } from "@ygo/api-client";
import { type Account, type ErrorCode, invalidFields, SetProfileBody } from "@ygo/contracts";

/** The code `Phone` puts before every number, shown fixed before C02's phone box. */
export const PHONE_PREFIX = "+91";

/**
 * What is wrong on C02, field by field:
 * - `name`: the name broke `PersonName`.
 * - `phone`: it broke `Phone`, or another account has it (#155, Q4).
 * - `other`: a problem with no field, shown under the button: no answer, or a server fault.
 */
export type ProfileProblems = {
  name: boolean;
  phone: "invalid" | "in-use" | null;
  other: ErrorCode | "offline" | null;
};

const none: ProfileProblems = { name: false, phone: null, other: null };

/** Field paths a check or the server named, as C02's problems; null when it names neither field. */
function byFields(fields: readonly string[]): ProfileProblems | null {
  const name = fields.includes("name");
  const phone = fields.includes("phone");
  return name || phone ? { ...none, name, phone: phone ? "invalid" : null } : null;
}

/** C02's fields checked with the server's own rule: the body to send, cleaned as the server stores it, or what is wrong. */
export function checkProfile(name: string, phone: string): { body: SetProfileBody } | { problems: ProfileProblems } {
  const parsed = SetProfileBody.safeParse({ name, phone });
  if (parsed.success) return { body: parsed.data };
  return { problems: byFields(invalidFields(parsed.error)) ?? { ...none, other: "VALIDATION_FAILED" } };
}

/** What happened to a save: the account the server answered, or what is wrong. */
export function saveOutcome(answer: ApiResult<Account> | "offline"): { saved: Account } | { problems: ProfileProblems } {
  if (answer === "offline") return { problems: { ...none, other: "offline" } };
  if (answer.ok) return { saved: answer.data };
  if (answer.code === "PHONE_IN_USE") return { problems: { ...none, phone: "in-use" } };
  const onFields = answer.code === "VALIDATION_FAILED" ? byFields(answer.fields ?? []) : null;
  return { problems: onFields ?? { ...none, other: answer.code } };
}

/** The field to focus after a refusal: the first wrong one, top to bottom. */
export function firstWrong(problems: ProfileProblems): "name" | "phone" | null {
  if (problems.name) return "name";
  return problems.phone ? "phone" : null;
}

/** A saved phone as the box shows it, after the fixed +91. */
export function phoneTyped(phone: string | null): string {
  return phone?.startsWith(PHONE_PREFIX) ? phone.slice(PHONE_PREFIX.length) : (phone ?? "");
}
