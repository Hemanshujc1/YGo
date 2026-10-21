import { createAdminApiClient } from "@ygo/api-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { adminRoutes } from "./routes";
import "./index.css";

const api = createAdminApiClient({
  baseUrl: "",
  onSignedOut: () => void router.navigate("/sign-in"),
});
const router = createBrowserRouter(adminRoutes(api));

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
