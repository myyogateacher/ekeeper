import { useState, type PropsWithChildren } from "react";
import { Link, NavLink } from "react-router-dom";
import { Activity, FileCode2, FolderKanban, LogOut, Settings, ShieldCheck, TriangleAlert } from "lucide-react";
import { HiOutlineBars3 } from "react-icons/hi2";
import type { User } from "@ekeeper/shared";

interface AppShellProps extends PropsWithChildren {
  user: User;
  onLogout: () => Promise<void>;
}

export function AppShell({ children, user, onLogout }: AppShellProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: Activity, adminOnly: false },
    { to: "/projects", label: "Projects", icon: FolderKanban, adminOnly: false },
    { to: "/users", label: "Users", icon: ShieldCheck, adminOnly: false },
    { to: "/errors", label: "Errors", icon: TriangleAlert, adminOnly: false },
    { to: "/minimaps", label: "Minimaps", icon: FileCode2, adminOnly: true },
    { to: "/settings", label: "Settings", icon: Settings, adminOnly: true },
  ].filter((item) => !item.adminOnly || user.role === "admin");

  return (
    <div className="min-h-screen py-6 pr-4 sm:pr-6 lg:pr-8">
      <div className="flex max-w-[1440px] gap-6 lg:gap-8">
        <aside
          className={`glass-panel sticky top-6 hidden h-[calc(100vh-3rem)] shrink-0 flex-col border-l-0 rounded-l-none p-4 transition-all duration-300 lg:flex ${
            isCollapsed ? "w-24" : "w-72"
          }`}
        >
          <div className={`mb-8 flex items-center ${isCollapsed ? "justify-center" : "justify-between gap-3"}`}>
            {!isCollapsed ? (
              <Link to="/dashboard" className="flex min-w-0 items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-300/20 text-xl font-semibold text-cyan-100">
                  eK
                </div>
                <div className="min-w-0">
                  <p className="text-sm uppercase tracking-[0.25em] text-cyan-100/70">Enterprise</p>
                  <h1 className="truncate text-xl font-semibold text-white">eKeeper</h1>
                </div>
              </Link>
            ) : null}

            <button
              type="button"
              className="button-secondary h-11 w-11 shrink-0 !p-0"
              onClick={() => setIsCollapsed((value) => !value)}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <HiOutlineBars3 className="mx-auto h-5 w-5" />
            </button>
          </div>

          <nav className="space-y-2 overflow-y-auto">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                title={isCollapsed ? label : undefined}
                className={({ isActive }) =>
                  `flex items-center rounded-2xl px-4 py-3 text-sm transition ${
                    isCollapsed ? "justify-center" : "gap-3"
                  } ${
                    isActive
                      ? "bg-white/10 text-white"
                      : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!isCollapsed ? <span>{label}</span> : null}
              </NavLink>
            ))}
          </nav>

          <div className={`mt-auto rounded-3xl border border-white/10 bg-slate-950/20 p-4 ${isCollapsed ? "text-center" : ""}`}>
            {!isCollapsed ? (
              <>
                <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Signed in</p>
                <p className="mt-2 text-lg font-semibold text-white">{user.name}</p>
                <p className="text-sm text-slate-300">{user.email}</p>
                <button className="button-secondary mt-5 w-full gap-2" onClick={() => void onLogout()}>
                  <LogOut className="h-4 w-4" />
                  Logout
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Link
                  to="/dashboard"
                  className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300/20 text-base font-semibold text-cyan-100"
                  title="Dashboard"
                >
                  eK
                </Link>
                <button
                  className="button-secondary h-11 w-11 !p-0"
                  title="Logout"
                  onClick={() => void onLogout()}
                >
                  <LogOut className="mx-auto h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mb-6 ml-4 flex items-center justify-between rounded-3xl border border-white/10 bg-white/6 px-5 py-4 backdrop-blur-md sm:ml-6 lg:hidden">
            <Link to="/dashboard" className="text-lg font-semibold text-white">
              eKeeper
            </Link>
            <button className="button-secondary" onClick={() => void onLogout()}>
              Logout
            </button>
          </div>
          <div className="ml-4 sm:ml-6 lg:ml-0">{children}</div>
        </main>
      </div>
    </div>
  );
}
