# ADR-0006: Web apps

- **Status**: Accepted
- **Date**: 2026-10-13
- **Ticket**: [#23 Web apps: Next.js evaluation](https://github.com/Hemanshujc1/YGo/issues/23)

## Context

Phase 1 has one authenticated web surface and, as this decision discovered, one public one.

Constraints fixed before this decision:

- **The Phase 1 surfaces are Customer Mobile, Shopkeeper Mobile and Admin Web** ([#2](https://github.com/Hemanshujc1/YGo/issues/2)). There is no Shopkeeper web and no customer web storefront.
- **Admin web is desktop-first with no phone layout** ([#12](https://github.com/Hemanshujc1/YGo/issues/12)), and its screen list is the [#7](https://github.com/Hemanshujc1/YGo/issues/7) cut, including Settlements, Complaints, Area Managers with payouts and search synonyms. Area Managers log in to it with a role scoped to the shops assigned to them (amended 27 Oct 2026, [#343](https://github.com/Hemanshujc1/YGo/issues/343): an Area Manager has no Area).
- **Styling tokens are shared with the mobile apps**, which use NativeWind v4 over semantic tokens — a deliberate soft constraint toward Tailwind on the web ([ADR-0001](0001-mobile-app-framework.md)).
- **The whole platform runs on one `t4g.small` with 2 GiB**, already hosting Fastify, Nginx and a nightly `pg_dump` ([ADR-0005](0005-hosting-and-operations.md)).
- **The API is REST `/v1` with shared Zod contracts** ([ADR-0004](0004-backend-shape-and-api-contract.md)), and sessions are an access token plus a server-side rotating refresh token.

## Decision

**No Next.js. Two Vite + React + TypeScript bundles with Tailwind, built to static files and served by Nginx on two hostnames.**

| Concern | Decision |
| --- | --- |
| Framework | **Vite 8 + React + React Router**, TypeScript strict |
| Styling | **Tailwind** over the `@ygo/tokens` semantic token source |
| Surfaces | **Two apps**: `apps/admin` and `apps/web` (public) |
| Rendering | Client-rendered. **No server-side rendering, no Node process for the web** |
| Hosting | Static files from Nginx on the existing instance, SPA fallback to `index.html` |
| Data | The `/v1` API through `@ygo/api-client`; no web-specific backend |
| Admin session | Access token **in memory only**; refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie on the registrable domain, with the refresh endpoint requiring a custom header |
| Shopkeeper web | **Not in Phase 1** |

**Why not Next.js.** Its value is server-side rendering, server components and search-engine visibility. Admin web is an authenticated dashboard: nothing to render for a crawler, nothing to cache for an anonymous visitor. Adopting it would add a second long-lived Node process to deploy, supervise and keep alive on a 2 GiB instance, in order to serve pages that can be flat files.

`output: 'export'` was examined as the serverless form and rejected on a concrete defect: a static export must know every dynamic route at build time, and Admin web routes to a single shop, order or settlement by an identifier that does not exist until runtime. Avoiding that means pushing identifiers into query strings to satisfy the build. React Router resolves the same routes client-side with no workaround.

**Why two apps.** They share a stack, `@ygo/tokens` and `@ygo/contracts`, and nothing else. The admin bundle contains every settlement, commission, shop-approval and Area Manager payout screen; keeping it separate behind its own hostname keeps all of that out of an anonymous visitor's browser. The API enforces authorisation either way, so this is hygiene rather than a security boundary — the same reasoning ADR-0001 used to reject one mobile bundle with role routing, at lower stakes, for the price of one build config.

**The public site, which this decision discovered.** Three already-settled obligations require publicly reachable pages and none had an owner: [#26](https://github.com/Hemanshujc1/YGo/issues/26) requires a public account-deletion request page before Play review; Google Play requires a public privacy policy URL; and ADR-0005 records that SES production access is commonly refused when the sending domain has no real site behind it, while SES is a soft-launch blocker because email is the sign-in mechanism. Scope: landing, privacy policy, terms, account-deletion request with its form, support contact. Five pages, on the critical path for both the Play release and email delivery.

**Why the admin session differs from mobile.** A browser has no secure device storage, and a refresh token in `localStorage` is readable by any successful cross-site scripting attack — on an account that can suspend shops and record settlement payments. So the access token is held in memory and lost on reload, and the refresh token sits in a cookie JavaScript cannot read. `SameSite=Strict` plus a required custom header on the refresh endpoint forces a preflight that a forged cross-site form cannot produce. ADR-0004's server-side refresh table and immediate revocation for [#17](https://github.com/Hemanshujc1/YGo/issues/17) are unchanged; this adds the browser storage rule it did not cover.

## Consequences

**What this forbids.** No Next.js in Phase 1, and therefore no server-side rendering, no server components and no web middleware. No second Node process for the web. No web-specific backend or API route layer. No refresh token in `localStorage` or `sessionStorage`. No literal colour in either web app — tokens only, per #12. No content management system for the public pages: editing them is a code change. No Shopkeeper web surface.

**What it requires that is easy to miss.** Two TLS certificates and two Nginx server blocks on Certbot renewal, and **a certificate expiry alarm in the ADR-0005 alarm set** — a renewal failure on the admin hostname locks the founder out of the only surface that can approve a shop. The public site live on the real domain well before launch week, because SES production access depends on it. And the SPA fallback configured in Nginx, without which a deep link into Admin web returns a 404 from disk.

**What it costs.** Client-rendered legal pages are invisible to anything that does not run JavaScript. A Play or SES reviewer using a plain fetcher would see empty pages. The mitigation, if it ever happens, is pre-rendering those five routes at build time, which Vite can do without changing framework. Separately, no server-side rendering means there is no server-side route guard: every authorisation decision is the API's, which was already true, but it makes the admin bundle public code that must be reviewed as such.

**What it buys.** Zero hosting cost, zero processes to supervise, nothing that can crash, and a deploy that is a file copy. One styling token source across four client surfaces. And a web stack a solo developer can hold entirely in their head.

**What it defers.** If a customer-facing web storefront is ever wanted, search-engine visibility becomes the point and Next.js becomes the right tool for that surface. Rewriting five static pages is a cheap price for deferring; adopting a rendering framework now is not.

## Alternatives considered

**Next.js with a Node server.** The default choice, the largest ecosystem, and genuinely the right answer for a public storefront. Rejected because Phase 1 has no public storefront, and the cost is a second supervised Node process on a 2 GiB instance to render pages that could be static.

**Next.js with `output: 'export'`.** Removes the server and keeps file-based routing. Rejected on the dynamic-route defect above: Admin web's identifiers do not exist at build time, so every detail route becomes a query-string workaround.

**One combined web app.** Simpler by one build config. Rejected because it ships every settlement and commission screen to anonymous visitors, for no gain.

**Astro for the public pages.** Excellent at static content with no JavaScript by default, and a better fit for five legal pages in isolation. Rejected as a third frontend framework in a stack maintained by one person, for pages that no one will search for during a hand-recruited pilot.

**Remix or TanStack Start.** Both reasonable, both full-stack frameworks solving the server-rendering problem this product does not have.

**A CDN in front of the static bundles.** Deferred with the rest of CloudFront in ADR-0005, until image traffic rather than page traffic justifies it.
