import type { ErrorCode } from "@ygo/contracts";

// Every string the app shows lives here, so translation is a later pass over
// one file (CONTEXT.md: every string externalised from day one).
export const strings = {
  title: "YGo Shopkeeper",
  health: "Server health",
  checking: "Checking…",
  ok: "ok",
  unreachable: "The server cannot be reached.",
  theme: { label: "Theme", system: "System", light: "Light", dark: "Dark" },
  update: {
    title: "Update YGo Shopkeeper",
    button: "Update",
    storeUnavailableMessage: "Update this app from the Play Store or App Store.",
  },
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
    UPDATE_REQUIRED: "This version of YGo Shopkeeper is too old. Update the app to continue.",
  } satisfies Record<ErrorCode, string>,
};
