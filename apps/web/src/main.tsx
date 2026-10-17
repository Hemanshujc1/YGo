import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, ScrollRestoration } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { strings } from "./strings";

// Every control is at least 48 by 48 (design-system.md section 4).
const tapTarget = "inline-flex min-h-12 min-w-12 items-center";

function Layout() {
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-6 px-4 py-3">
        <Link to="/" className={`mr-auto text-xl font-semibold text-brand ${tapTarget}`}>
          {strings.name}
        </Link>
        <nav className="flex gap-4 text-primary">
          <Link to="/privacy" className={tapTarget}>
            {strings.nav.privacy}
          </Link>
          <Link to="/terms" className={tapTarget}>
            {strings.nav.terms}
          </Link>
          <Link to="/support" className={tapTarget}>
            {strings.nav.support}
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-10">
        <Outlet />
      </main>
      <ScrollRestoration />
    </div>
  );
}

function Page({ title, documentTitle, children }: { title: string; documentTitle?: string; children: ReactNode }) {
  return (
    <>
      <title>{documentTitle ?? strings.pageTitle(title)}</title>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-4 space-y-4">{children}</div>
    </>
  );
}

function Placeholder() {
  return <p className="rounded-xl bg-warning-subtle p-4 text-on-warning-subtle">{strings.placeholder}</p>;
}

function SupportEmail() {
  return (
    <a href={`mailto:${strings.supportEmail}`} className="text-primary underline">
      {strings.supportEmail}
    </a>
  );
}

const router = createBrowserRouter([
  {
    Component: Layout,
    children: [
      {
        path: "/",
        element: (
          <Page title={strings.tagline} documentTitle={strings.name}>
            <p className="text-muted">{strings.intro}</p>
          </Page>
        ),
      },
      {
        path: "/privacy",
        element: (
          <Page title={strings.privacy.title}>
            <Placeholder />
          </Page>
        ),
      },
      {
        path: "/terms",
        element: (
          <Page title={strings.terms.title}>
            <Placeholder />
          </Page>
        ),
      },
      {
        path: "/support",
        element: (
          <Page title={strings.support.title}>
            <p>
              {strings.support.writeBefore}
              <SupportEmail />
              {strings.support.writeAfter}
            </p>
            <p className="text-muted">{strings.support.liveOrder}</p>
          </Page>
        ),
      },
      {
        path: "*",
        element: (
          <Page title={strings.notFound.title}>
            <p className="text-muted">{strings.notFound.body}</p>
          </Page>
        ),
      },
    ],
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
