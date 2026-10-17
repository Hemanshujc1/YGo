import { randomUUID } from "node:crypto";

export type IdentityProvider = "google" | "apple";

/**
 * Checks a Google or Apple identity token and yields the email it proves
 * (PRD ACC-1, ADR-0004 amendment). Null when the token does not verify.
 */
export interface IdentityVerifier {
  verify(provider: IdentityProvider, token: string): Promise<{ email: string } | null>;
}

/** Accepts only the tokens the test minted, for the provider it minted them for. */
export function createLocalIdentityVerifier(): IdentityVerifier & {
  mint(provider: IdentityProvider, email: string): string;
} {
  const minted = new Map<string, { provider: IdentityProvider; email: string }>();
  return {
    mint(provider: IdentityProvider, email: string) {
      const token = randomUUID();
      minted.set(token, { provider, email });
      return token;
    },
    async verify(provider: IdentityProvider, token: string) {
      const identity = minted.get(token);
      return identity?.provider === provider ? { email: identity.email } : null;
    },
  };
}
