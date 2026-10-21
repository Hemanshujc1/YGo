import type { ErrorCode } from "@ygo/contracts";
import type { ProfileWords, SignInWords } from "@ygo/mobile";

// Every string the app shows lives here, so translation is a later pass over
// one file (CONTEXT.md: every string externalised from day one).
export const strings = {
  update: {
    title: "Update YGo Shopkeeper",
    button: "Update",
    storeUnavailableMessage: "Update this app from the Play Store or App Store.",
  },
  // C01 and C14 (#155). The support email comes from EXPO_PUBLIC_SUPPORT_EMAIL, never from here.
  signIn: {
    title: "YGo for shops",
    lead: "Sign in to see and manage your shop's orders.",
    emailLabel: "Email",
    emailInvalid: "Enter an email address, such as asha@example.com.",
    send: "Email me a code",
    help: "Help:",
    code: {
      title: "Check your email",
      sentTo: (email: string) => `We sent a 6-digit code to ${email}. Enter it here to sign in.`,
      label: "Code",
      checking: "Checking code",
      resend: "Send a new code",
      resendIn: (seconds: number) => `Send a new code in 0:${String(seconds).padStart(2, "0")}`,
      otherEmail: "Use a different email",
      spam: "Not in your inbox? Look in spam or promotions.",
    },
    offline: {
      send: "Could not send the code. Check your connection, then send it again.",
      check: "Could not check the code. Check your connection, then enter it again.",
    },
    notSaved: "This phone could not keep you signed in. Send a new code and try again.",
  } satisfies Omit<SignInWords, "errors">,
  // C02 (#155). The +91 before the phone comes from the Phone rule, never from here.
  profile: {
    title: "Your name and phone number",
    lead: "YGo uses these to reach you about your shop. Each phone number can have one account.",
    nameLabel: "Your name",
    nameInvalid: "Enter your name in letters, such as Asha Kulkarni.",
    phoneLabel: "Phone number",
    phoneInvalid: "Enter a 10-digit mobile number, such as 98765 43210.",
    inUse: {
      title: "Is it your number?",
      body: "Write to us from this email and we will help you get into the right account.",
    },
    save: "Continue",
    saving: "Saving…",
    signOut: "Sign out",
    offline: "Could not save. Check your connection, then try again.",
  } satisfies Omit<ProfileWords, "errors">,
  // The screen picker's own words (#155, Q3 and Q5).
  session: {
    unreachable: {
      title: "Can't reach YGo",
      body: "Check your internet connection, then try again.",
      retry: "Try again",
    },
    notCleared:
      "You are signed out. This phone could not clear its saved sign-in, so it will try again the next time the app opens.",
  },
  // The signed-in screen until #40 and #58 link accounts to shops (#157).
  notLinked: {
    title: "You're not linked to a shop yet",
    body: "Your shop's orders will show here once you're linked to a shop.",
    signedInAs: (email: string) => `Signed in as ${email}`,
  },
  // The server sends a machine code, never words (ADR-0004). @ygo/api-client
  // already turns a code it does not know into INTERNAL.
  errors: {
    VALIDATION_FAILED: "The server did not accept the request.",
    NOT_FOUND: "The server does not know this request.",
    UNAVAILABLE: "The server is running, but a service it needs is not answering.",
    INTERNAL: "Something went wrong on the server.",
    UPDATE_REQUIRED: "This version of YGo Shopkeeper is too old. Update the app to continue.",
    UNAUTHENTICATED: "Sign in to continue.",
    PROFILE_REQUIRED: "Add your name and phone number to continue.",
    CODE_WRONG: "That code is not right. Check the newest email from YGo and try again.",
    CODE_EXPIRED: "That code has expired. Ask for a new one.",
    CODE_LOCKED: "Too many wrong codes. Try again in 15 minutes.",
    TOO_MANY_REQUESTS: "Too many tries. Wait a little and try again.",
    PHONE_IN_USE: "This number is already used by another account.",
    EMAIL_IN_USE: "This email is already used by another account.",
    FORBIDDEN: "This account is not allowed to do that.",
  } satisfies Record<ErrorCode, string>,
};
