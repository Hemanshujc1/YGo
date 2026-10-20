import type { ErrorCode } from "@ygo/contracts";
import type { SignInWords } from "@ygo/mobile";

// Every string the app shows lives here, so translation is a later pass over
// one file (CONTEXT.md: every string externalised from day one).
export const strings = {
  title: "YGo",
  health: "Server health",
  checking: "Checking…",
  ok: "ok",
  unreachable: "The server cannot be reached.",
  theme: { label: "Theme", system: "System", light: "Light", dark: "Dark" },
  update: {
    title: "Update YGo",
    button: "Update",
    storeUnavailableMessage: "Update this app from the Play Store or App Store.",
  },
  // C01 and C14 (#155). The support email comes from EXPO_PUBLIC_SUPPORT_EMAIL, never from here.
  signIn: {
    title: "YGo",
    heading: "Order from shops near you",
    lead: "Shops within 2 to 3 km deliver with their own staff. You pay the shop at the door, in cash or UPI.",
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
  } satisfies Omit<SignInWords, "errors">,
  // The Inter review (design system, section 10), until real screens replace it.
  review: {
    sizes: "Type sizes",
    display: "Display 28",
    titleLarge: "Title large 24",
    titleText: "Title 20",
    headline: "Headline 18",
    body: "Body 16",
    label: "Label 16",
    secondary: "Secondary 14",
    smallLabel: "Small label 13",
    caption: "Caption 12",
    weights: "Weights",
    regular: "Inter 400 Regular ₹",
    medium: "Inter 500 Medium ₹",
    semibold: "Inter 600 SemiBold ₹",
    formats: "Formats",
    prices: "Price column",
    countdown: "Countdown",
    tabs: "Tab labels",
    tabLabels: ["Orders", "Bill", "Stock", "Deliveries", "More"],
    hindi: "Hindi line height",
    hindiSample: "आपका ऑर्डर तैयार है, कृपया दुकान पर आएँ।",
  },
  // The server sends a machine code, never words (ADR-0004). @ygo/api-client
  // already turns a code it does not know into INTERNAL.
  errors: {
    VALIDATION_FAILED: "The server did not accept the request.",
    NOT_FOUND: "The server does not know this request.",
    UNAVAILABLE: "The server is running, but a service it needs is not answering.",
    INTERNAL: "Something went wrong on the server.",
    UPDATE_REQUIRED: "This version of YGo is too old. Update the app to continue.",
    UNAUTHENTICATED: "Sign in to continue.",
    PROFILE_REQUIRED: "Add your name and phone number to continue.",
    CODE_WRONG: "That code is not right. Check the newest email from YGo and try again.",
    CODE_EXPIRED: "That code has expired. Ask for a new one.",
    CODE_LOCKED: "Too many wrong codes. Try again in 15 minutes.",
    TOO_MANY_REQUESTS: "Too many tries. Wait a little and try again.",
    PHONE_IN_USE: "Another account already uses this phone number. Contact support for help.",
  } satisfies Record<ErrorCode, string>,
};
