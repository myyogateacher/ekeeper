import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "@fontsource-variable/inter";
import App from "./App";
import { isApiStatus } from "./lib/api-error";
import { endSession } from "./lib/session";
import "./index.css";

// A 401 on any query or mutation other than the session query itself (which resolves a 401 to null, see
// lib/session.ts) means the session ended: expired, or its Redis key was deleted. endSession drops the cached
// data and writes null into the session query, which makes ProtectedLayout redirect to /login.
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isApiStatus(error, 401)) {
        endSession(queryClient);
      }
    },
  }),
  // One error toast for every failed mutation, so no write fails silently (several did: issue workflow,
  // project create and delete). A mutation that handles its own error says so with an onError.
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      // The redirect to /login is the message for an ended session; a toast on top of it would appear on the
      // login page.
      if (isApiStatus(error, 401)) {
        endSession(queryClient);
        return;
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
