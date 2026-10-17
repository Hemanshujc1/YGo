import { createApiClient } from "@ygo/api-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, useLoaderData } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { strings } from "./strings";

const api = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "" });

const healthLoader = () => api.health();

function Page({ answer }: { answer: string }) {
  return (
    <main className="min-h-screen bg-bg p-10 text-text">
      <h1 className="text-2xl font-semibold text-brand">{strings.title}</h1>
      <p className="mt-6 text-muted">{strings.health}</p>
      <p className="mt-1 text-text">{answer}</p>
    </main>
  );
}

function Health() {
  const result = useLoaderData<typeof healthLoader>();
  return <Page answer={result.ok ? strings.ok : `${result.status} ${result.code}`} />;
}

const router = createBrowserRouter([
  {
    path: "/",
    loader: healthLoader,
    Component: Health,
    HydrateFallback: () => <Page answer={strings.checking} />,
    ErrorBoundary: () => <Page answer={strings.unreachable} />,
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
