import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { rememberPathForLogin, takePathAfterLogin } from "@/lib/after-login";
import { ErrorDetailPage } from "@/pages/ErrorDetailPage";
import { ErrorsPage } from "@/pages/ErrorsPage";
import { LoginPage } from "@/pages/LoginPage";
import { MinimapsPage } from "@/pages/MinimapsPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { UsersPage } from "@/pages/UsersPage";

function ProtectedLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted" role="status">
        Loading
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
        await queryClient.cancelQueries({ queryKey: ["me"] });
        queryClient.removeQueries({ queryKey: ["me"], exact: true });
        navigate("/login", { replace: true });
      }}
    >
      <Outlet context={data} />
    </AppShell>
  );
}

function LoginRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });

  if (data) {
    return <Navigate to={takePathAfterLogin() ?? "/errors"} replace />;
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

// The backend lands every sign-in on /dashboard (backend/src/routes/auth.ts:25). Overview was dropped, so
// that path restores the page a logged-out user was sent away from, else opens the issues list.
function AfterLoginRedirect() {
  return <Navigate to={takePathAfterLogin() ?? "/errors"} replace />;
}

// /errors and /errors/:projectId/:groupId stay the canonical URLs: GitHub issue bodies link to the latter
// (backend/src/lib/issue-sync.ts:181), so renaming them would need a redirect kept forever.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Navigate to="/errors" replace />} />
        <Route path="/dashboard" element={<AfterLoginRedirect />} />
        <Route path="/errors" element={<ErrorsPage />} />
        <Route path="/errors/:projectId/:groupId" element={<ErrorDetailPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/minimaps" element={<MinimapsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/errors" replace />} />
    </Routes>
  );
}
