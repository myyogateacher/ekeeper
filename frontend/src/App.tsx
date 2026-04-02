import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { DashboardPage } from "@/pages/DashboardPage";
import { ErrorDetailPage } from "@/pages/ErrorDetailPage";
import { ErrorsPage } from "@/pages/ErrorsPage";
import { LoginPage } from "@/pages/LoginPage";
import { MinimapsPage } from "@/pages/MinimapsPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { UsersPage } from "@/pages/UsersPage";

function ProtectedLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-200">Loading workspace...</div>;
  }

  if (!data) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppShell
      user={data.user}
      onLogout={async () => {
        await api.logout();
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        navigate("/login");
      }}
    >
      <Outlet />
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
    return <Navigate to="/dashboard" replace />;
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/errors" element={<ErrorsPage />} />
        <Route path="/errors/:projectId/:groupId" element={<ErrorDetailPage />} />
        <Route path="/minimaps" element={<MinimapsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
