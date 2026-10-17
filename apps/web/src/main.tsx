import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { strings } from "./strings";

function Layout() {
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6">
        <Link to="/" className="mr-auto text-xl font-semibold text-brand">
          {strings.name}
        </Link>
        <nav className="flex gap-6 text-primary">
          <Link to="/privacy">{strings.nav.privacy}</Link>
          <Link to="/terms">{strings.nav.terms}</Link>
          <Link to="/support">{strings.nav.support}</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-10">
        <Outlet />
      </main>
    </div>
  );
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <title>{`${title} · ${strings.name}`}</title>
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
        Component: () => (
          <Page title={strings.tagline}>
            <p className="text-muted">{strings.intro}</p>
          </Page>
        ),
      },
      {
        path: "/privacy",
        Component: () => (
          <Page title={strings.privacy.title}>
            <Placeholder />
          </Page>
        ),
      },
      {
        path: "/terms",
        Component: () => (
          <Page title={strings.terms.title}>
            <Placeholder />
          </Page>
        ),
      },
      {
        path: "/support",
        Component: () => (
          <Page title={strings.support.title}>
            <p>
              {strings.support.write} <SupportEmail />.
            </p>
            <p className="text-muted">{strings.support.liveOrder}</p>
          </Page>
        ),
      },
      {
        path: "*",
        Component: () => (
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
