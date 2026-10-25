import type { ApiResult } from "@ygo/api-client";
import type { Account, IdentityChallengeBody, VerifyIdentityBody, IdentityChallenge, IdentityEmailRequired, ErrorCode } from "@ygo/contracts";

export interface IdentityApi {
  identityChallenge(body: IdentityChallengeBody): Promise<ApiResult<typeof IdentityChallenge._output>>;
  verifyIdentity(body: VerifyIdentityBody): Promise<ApiResult<Account | typeof IdentityEmailRequired._output>>;
}

type IdentityOutcome = { signedIn: Account } | { email: string } | { cancelled: true }
  | { problem: ErrorCode | "offline" | "not-saved" | "provider" };

/** Native cancellation is quiet; a mailbox challenge returns to the existing email-code flow. */
export async function signInWithIdentity(
  api: IdentityApi,
  provider: IdentityChallengeBody["provider"],
  token: (nonce: string) => Promise<string | null>,
): Promise<IdentityOutcome> {
  let challenge;
  try { challenge = await api.identityChallenge({ provider }); }
  catch { return { problem: "offline" as const }; }
  if (!challenge.ok) return { problem: challenge.code };
  let identityToken;
  try { identityToken = await token(challenge.data.nonce); }
  catch { return { problem: "provider" as const }; }
  if (identityToken === null) return { cancelled: true as const };
  try {
    const answer = await api.verifyIdentity({ provider, identityToken, nonce: challenge.data.nonce });
    if (!answer.ok) return { problem: answer.code };
    return "emailVerificationRequired" in answer.data
      ? { email: answer.data.emailVerificationRequired }
      : { signedIn: answer.data };
  } catch (error) {
    return { problem: error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) ? "offline" as const : "not-saved" as const };
  }
}
