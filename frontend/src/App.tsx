import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { api, meQuery } from "@/lib/api";
import { endSession } from "@/lib/session";
import { announceLogout, useSessionSync } from "@/components/useSessionSync";
import { clearPathAfterLogin, forgetPathAfterLogout, peekPathAfterLogin, rememberPathForLogin } from "@/lib/after-login";
import { ErrorDetailPage } from "@/pages/ErrorDetailPage";
import { ErrorsPage } from "@/pages/ErrorsPage";
import { LandingPage } from "@/pages/LandingPage";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsPage } from "@/pages/SettingsPage";

function LoadingStatus() {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted" role="status">
      Loading
    </div>
  );
}

function ProtectedLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery(meQuery);

  if (isLoading) {
    return <LoadingStatus />;
  }

  // api.me resolves a 401 to null, so an error here is an outage (a 5xx during a deploy, no network), not a
  // signed-out user. Sending them to /login would also remember the page and make them sign in again for a
  // problem sign-in cannot fix. A background refetch that fails while `data` is cached keeps showing the app.
  if (isError && !data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <EmptyState
          title="Couldn't reach eKeeper"
          action={
            <button type="button" className="btn" disabled={isFetching} onClick={() => void refetch()}>
              Try again
            </button>
          }
        >
          The server didn't answer. Check your connection and try again in a moment.
        </EmptyState>
      </div>
    );
  }

  if (!data) {
    rememberPathForLogin(`${location.pathname}${location.search}`);
    return <Navigate to="/login" replace />;
  }

  return (
    <AppShell
      user={data.user}
      onLogout={async () => {
        await api.logout();
        // The page is forgotten first, and stays forgotten: endSession below makes the layout re-render on
        // this page before the navigation lands, and that render used to remember it again. An explicit logout
        // is not an expiry, so whoever signs in next on this browser is not coming back to it; other tabs are
        // told so they forget theirs. In-flight requests are cancelled so a late response cannot repopulate the
        // cache endSession empties.
        forgetPathAfterLogout();
        announceLogout();
        await queryClient.cancelQueries();
        endSession(queryClient);
        navigate("/login", { replace: true });
      }}
    >
      <RouteErrorBoundary title="This page couldn't be displayed">
        <Outlet context={data} />
      </RouteErrorBoundary>
    </AppShell>
  );
}

function LoginRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery(meQuery);

  if (data) {
    return <RedirectAfterLogin />;
  }

  return (
    <LoginPage
      onLogin={async () => {
        const response = await api.loginUrl();
        navigate("/login", { replace: true });
        window.location.href = response.url;
        await queryClient.invalidateQueries({ queryKey: ["me"] });
      }}
    />
  );
}

// `/` is outside ProtectedLayout so a signed-out visitor sees the landing page instead of being sent to /login.
// A failed /api/me (a 5xx during a deploy, no network) also shows the landing page: it is static content that
// needs nothing from the server, so an outage must not turn the front door into an error screen, and a sign-in
// start that fails reports its own error (LandingPage toasts it). While /api/me is loading this renders the
// same status as ProtectedLayout, so a signed-in user never sees the landing page flash before the redirect.
// The backend's MCP OAuth authorize sends a signed-out user to `${FRONTEND_URL}/?next=...`
// (backend/src/routes/oauth.ts:93) and nothing here reads `next`: before this route `/` went to /login and then
// /errors, and now it shows the landing page, whose Sign in button reaches the same Google sign-in.
function HomeRoute() {
  const { data, isLoading } = useQuery(meQuery);

  if (isLoading) {
    return <LoadingStatus />;
  }

  if (data) {
    return <Navigate to="/errors" replace />;
  }

  return (
    <LandingPage
      onLogin={async (returnTo) => {
        const response = await api.loginUrl();
        // After loginUrl resolves, so a failed start leaves no remembered page for a later sign-in to follow.
        // RedirectAfterLogin restores it when Google lands the user on /dashboard.
        if (returnTo) {
          rememberPathForLogin(returnTo);
        }
        window.location.href = response.url;
      }}
    />
  );
}

// Sends a signed-in user to the page a logged-out click was sent away from (a GitHub issue link), else to the
// issues list. The backend lands every sign-in on /dashboard (backend/src/routes/auth.ts:25) and Overview was
// dropped, so that path renders this too. The target is read once into state, not on every render: render
// runs twice under StrictMode and can repeat in production, and a target recomputed after the clear below
// would flip to /errors and replace the deep link. The clear is an effect for the same reason, so no render
// consumes the stored path.
function RedirectAfterLogin() {
  const [target] = useState(() => peekPathAfterLogin() ?? "/errors");
  useEffect(() => {
    clearPathAfterLogin();
  }, []);
  return <Navigate to={target} replace />;
}

// /errors and /errors/:projectId/:groupId stay the canonical URLs: GitHub issue bodies link to the latter
// (backend/src/lib/issue-sync.ts:181), so renaming them would need a redirect kept forever.
export default function App() {
  useSessionSync();
  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/dashboard" element={<RedirectAfterLogin />} />
        <Route path="/errors" element={<ErrorsPage />} />
        <Route
          path="/errors/:projectId/:groupId"
          element={
            <RouteErrorBoundary title="This issue couldn't be displayed">
              <ErrorDetailPage />
            </RouteErrorBoundary>
          }
        />
        {/* The old top level pages moved into Settings; their URLs stay working for bookmarks. */}
        <Route path="/projects" element={<Navigate to="/settings/projects" replace />} />
        <Route path="/users" element={<Navigate to="/settings/members" replace />} />
        <Route path="/minimaps" element={<Navigate to="/settings/source-maps" replace />} />
        <Route path="/settings" element={<Navigate to="/settings/projects" replace />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/errors" replace />} />
    </Routes>
  );
}
