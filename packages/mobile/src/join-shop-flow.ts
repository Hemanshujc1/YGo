import type { ApiResult } from "@ygo/api-client";
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, JoinShopBody, type JoinShopResponse } from "@ygo/contracts";

/** What S21 can say is wrong with the code. `short` is a check on the phone; the rest come from the server. */
export type JoinProblem = "short" | "wrong" | "expired" | "locked" | "linked" | "offline" | "other";

/**
 * What the field keeps of what is typed or pasted: the code's own characters in capitals, at most one code long. A space
 * or dash from reading the code aloud or pasting it is dropped, and so are the letters the server never draws.
 */
export function cleanCode(text: string): string {
  return [...text.toUpperCase()].filter((char) => JOIN_CODE_ALPHABET.includes(char)).slice(0, JOIN_CODE_LENGTH).join("");
}

/** Sends the code once it has the server's own shape. Null `join` answer means the phone could not reach the server. */
export async function tryJoin(
  code: string,
  join: (body: JoinShopBody) => Promise<ApiResult<JoinShopResponse>>,
): Promise<{ shopName: string | null } | { problem: JoinProblem }> {
  const body = JoinShopBody.safeParse({ code });
  if (!body.success) return { problem: "short" };
  const answer = await join(body.data).catch(() => null);
  if (!answer) return { problem: "offline" };
  if (answer.ok) return { shopName: answer.data.shopName };
  const known = { CODE_WRONG: "wrong", CODE_EXPIRED: "expired", CODE_LOCKED: "locked", ALREADY_LINKED: "linked" } as const;
  return { problem: known[answer.code as keyof typeof known] ?? "other" };
}
