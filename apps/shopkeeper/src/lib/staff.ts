import { Phone } from "@ygo/contracts";
import { formatPhone } from "@ygo/format";

/** The person's name, else their number, so two unnamed people are still told apart (S16). */
export const personLabel = (person: { name: string | null; phone: string | null }): string =>
  person.name ?? (person.phone ? formatPhone(person.phone) : "");

/** What the Owner typed read as the stored number, or null when it isn't a mobile number (the server's rule, `Phone`). */
export function readInvitePhone(text: string): string | null {
  const read = Phone.safeParse(text);
  return text.trim() !== "" && read.success ? read.data : null;
}

/** An open invitation whose code ran out can only be replaced, not used. */
export const codeRanOut = (expiresAt: string | null, now: number): boolean => expiresAt !== null && Date.parse(expiresAt) <= now;
