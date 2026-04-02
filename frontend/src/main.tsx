import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ToastContainer
          position="bottom-right"
          autoClose={2500}
          hideProgressBar
          closeButton={false}
          newestOnTop
          theme="dark"
          toastClassName={() =>
            "rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-slate-100 shadow-2xl backdrop-blur-xl"
          }
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
