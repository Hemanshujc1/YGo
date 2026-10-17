import { createApiClient } from "@ygo/api-client";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { strings } from "./strings";

const api = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "" });

// health() rejects only when no answer came back: offline, refused or timed out.
const healthLoader = () => api.health().catch(() => "unreachable" as const);

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-bg p-10 text-text">
      <h1 className="text-2xl font-semibold text-brand">{strings.title}</h1>
      <div className="mt-6">{children}</div>
    </main>
  );
}

function Health() {
  const result = useLoaderData<typeof healthLoader>();
  const answer =
    result === "unreachable" ? strings.unreachable : result.ok ? strings.ok : strings.errors[result.code];
  return (
    <Page>
      <p className="text-muted">{strings.health}</p>
      <p className="mt-1">{answer}</p>
    </Page>
  );
}

function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return <Page>{notFound ? strings.notFound : strings.failed}</Page>;
}

const router = createBrowserRouter([
  {
    path: "/",
    loader: healthLoader,
    Component: Health,
    HydrateFallback: () => <Page>{strings.checking}</Page>,
    ErrorBoundary: RouteError,
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
