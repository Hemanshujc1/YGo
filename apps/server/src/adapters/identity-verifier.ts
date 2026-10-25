import { randomUUID } from "node:crypto";
import { Email, type IdentityProvider } from "@ygo/contracts";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

export type { IdentityProvider } from "@ygo/contracts";
export interface Identity {
  email: string;
  emailCodeRequired?: boolean;
}
/** Only the signed token's claims prove an email; never trust client profile data. */
export interface IdentityVerifier {
  verify(provider: IdentityProvider, token: string, nonce?: string): Promise<Identity | null>;
}

export function createIdentityVerifier(audiences: Record<IdentityProvider, string[]>): IdentityVerifier {
  const keys = {
    google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
    apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
  };
  return {
    async verify(provider, token, nonce) {
      if (!audiences[provider].length) return null;
      try {
        const { payload } = await jwtVerify(token, keys[provider], {
          algorithms: ["RS256"],
          issuer: provider === "google" ? ["https://accounts.google.com", "accounts.google.com"] : "https://appleid.apple.com",
          audience: audiences[provider],
          requiredClaims: ["sub", "exp", "iat", "email", "email_verified", "nonce"],
          maxTokenAge: "5m",
        });
        const email = Email.safeParse(payload.email);
        if (!nonce || payload.nonce !== nonce || !email.success || !payload.sub ||
            !(payload.email_verified === true || (provider === "apple" && payload.email_verified === "true"))) return null;
        return {
          email: email.data,
          // Google warns email_verified alone cannot prove a third-party mailbox.
          emailCodeRequired: provider === "google" && !email.data.endsWith("@gmail.com") &&
            !(typeof payload.hd === "string" && payload.hd.length > 0),
        };
      } catch (error) {
        if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) return null;
        throw error;
      }
    },
  };
}

/** Accepts only tokens the test minted, for their provider and optional nonce. */
export function createLocalIdentityVerifier(): IdentityVerifier & {
  mint(provider: IdentityProvider, email: string, nonce?: string, emailCodeRequired?: boolean): string;
} {
  const minted = new Map<string, { provider: IdentityProvider; email: string; nonce?: string; emailCodeRequired?: boolean }>();
  return {
    mint(provider, email, nonce, emailCodeRequired) {
      const token = randomUUID();
      minted.set(token, { provider, email, nonce, emailCodeRequired });
      return token;
    },
    async verify(provider, token, nonce) {
      const identity = minted.get(token);
      if (identity?.provider !== provider || identity.nonce !== nonce) return null;
      return identity.emailCodeRequired === undefined ? { email: identity.email }
        : { email: identity.email, emailCodeRequired: identity.emailCodeRequired };
    },
  };
}
