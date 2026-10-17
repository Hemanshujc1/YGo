// Every string the site shows lives here, so translation is a later pass over
// one file (CONTEXT.md: every string externalised from day one).
export const strings = {
  name: "YGo",
  tagline: "Local shops near you.",
  pageTitle: (page: string) => `${page} · YGo`,
  intro: "Order from the shops in your own neighbourhood. Each shop delivers with its own staff.",
  // TRU-6: the one support channel, an address on the brand domain. The domain
  // is not chosen yet (#27), so this is a placeholder; L-12 sets up the mailbox.
  supportEmail: "support@example.com",
  nav: {
    privacy: "Privacy",
    terms: "Terms",
    support: "Support",
  },
  // Placeholder legal text until the launch checklist supplies it (L-3).
  placeholder: "This is a placeholder. The final text will be published here before YGo launches.",
  privacy: {
    title: "Privacy policy",
  },
  terms: {
    title: "Terms of use",
  },
  support: {
    title: "Support",
    // The email link sits between the two halves.
    writeBefore: "Write to us at ",
    writeAfter: ".",
    liveOrder: "For an order in progress, call the shop from the order screen in the app. The shop can fix the order.",
  },
  notFound: {
    title: "Page not found",
    body: "This page does not exist.",
  },
};
