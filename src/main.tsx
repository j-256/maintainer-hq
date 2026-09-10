import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./app";
import { TooltipProvider } from "./components/ui/tooltip";
import { LIMITS } from "../shared/domain";
import "./index.css";
import "./workspace.css";
import "./repositories.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: LIMITS.REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  },
});
const router = createBrowserRouter([
  {
    path: "/*",
    element: <App />,
    errorElement: (
      <main className="empty-state">
        <h1>This view could not be opened</h1>
        <p>Your saved workspace data is unchanged. Reload to try again.</p>
        <button onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </main>
    ),
  },
]);
try {
  document.documentElement.classList.toggle(
    "dark",
    localStorage.getItem("hq.theme.v1") !== "light",
  );
} catch {
  /* Default to the document theme */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
