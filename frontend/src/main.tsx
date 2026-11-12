import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "@fontsource-variable/inter";
import App from "./App";
import { isApiStatus } from "./lib/api";
import "./index.css";

const queryClient: QueryClient = new QueryClient({
  // A 401 anywhere means the session ended (expired or revoked in Redis). Dropping the cached "me" makes
  // ProtectedLayout send the user to /login instead of every query failing in place.
  queryCache: new QueryCache({
    onError: (error) => {
      if (isApiStatus(error, 401)) {
        queryClient.removeQueries({ queryKey: ["me"], exact: true });
      }
    },
  }),
  // One error toast for every failed mutation, so no write fails silently (several did: issue workflow,
  // project create and delete). A mutation that handles its own error says so with an onError.
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (isApiStatus(error, 401)) {
        queryClient.removeQueries({ queryKey: ["me"], exact: true });
      }
      if (mutation.options.onError) {
        return;
      }
      toast.error(error instanceof Error ? error.message : "Request failed");
    },
  }),
  defaultOptions: {
    queries: {
      // A refusal (4xx) will not change on retry; an outage or a 5xx might, so those get two more tries.
      retry: (failureCount, error) => !isApiStatus(error, 400, 401, 403, 404) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ToastContainer
          position="bottom-right"
          autoClose={4000}
          hideProgressBar
          closeButton={false}
          newestOnTop
          toastClassName={() =>
            "relative mb-2 flex min-h-0 items-center gap-3 rounded-lg border border-line bg-fg px-3.5 py-2.5 text-[13px] text-bg shadow-lg"
          }
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
