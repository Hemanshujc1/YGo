import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { strings } from "./strings";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <main className="min-h-screen bg-bg p-10 text-text">
      <h1 className="text-2xl font-semibold text-brand">{strings.name}</h1>
      <p className="mt-2 text-muted">{strings.tagline}</p>
    </main>
  </StrictMode>,
);
