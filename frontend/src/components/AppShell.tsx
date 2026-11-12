import { useEffect, useState, type PropsWithChildren } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Inbox, LogOut, Menu, SlidersHorizontal, X } from "lucide-react";
import type { User } from "@ekeeper/shared";
import { api } from "@/lib/api";
import {
  DEFAULT_QUERY,
  SAVED_VIEWS,
  matchSavedView,
  parseListQuery,
  projectCounts,
  savedViewHref,
  serializeListQuery,
  viewCounts,
} from "@/lib/issue-list";
import { useIssueSet } from "@/components/useIssueSet";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { initials } from "@/components/AssignMenu";

interface AppShellProps extends PropsWithChildren {
  user: User;
  onLogout: () => Promise<void>;
}

const navItem =
  "flex min-h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-fg max-[720px]:min-h-11";

/**
 * Sidebar on desktop; under 720px a top bar whose menu opens the same nav inline and closes on navigation.
 * Issues is the home page and owns the saved views; Settings and the account sit at the bottom.
 */
export function AppShell({ children, user, onLogout }: AppShellProps) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  // The default list view's own set (open and reopened, 7 days, all projects), so on the home page the
  // counts cost no extra request. Counts are hidden when this set is capped or inconsistent.
  const { data: baseSet } = useIssueSet(DEFAULT_QUERY, user.id);
  const counts = baseSet ? viewCounts(baseSet, user.id) : null;
  const perProject = baseSet ? projectCounts(baseSet) : null;

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);

  const onIssues = location.pathname === "/errors";
  const listQuery = parseListQuery(new URLSearchParams(location.search));
  const activeView = onIssues ? matchSavedView(listQuery) : null;

  return (
    <div className="flex min-h-screen flex-wrap items-stretch">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col border-r border-line bg-surface px-3 py-4 max-[720px]:static max-[720px]:h-auto max-[720px]:w-full max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:py-2">
        <div className="flex items-center gap-2.5 px-2.5 pb-4 max-[720px]:px-1 max-[720px]:pb-0">
          <Link to="/errors" className="flex flex-1 items-center gap-2.5">
            <span className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-ink">
              eK
            </span>
            <span className="text-[15px] font-semibold">eKeeper</span>
          </Link>
          <button
            type="button"
            className="btn btn-ghost btn-icon hidden max-[720px]:inline-flex"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
          </button>
        </div>

        <div
          id="primary-nav"
          className={`flex flex-1 flex-col gap-0.5 overflow-y-auto max-[720px]:pt-2 ${menuOpen ? "" : "max-[720px]:hidden"}`}
        >
          <nav aria-label="Issues" className="flex flex-col gap-0.5">
            <Link to="/errors" className={`${navItem} ${onIssues ? "text-fg" : ""}`}>
              <Inbox className="h-4 w-4" aria-hidden />
              Issues
            </Link>
            {SAVED_VIEWS.map((view) => {
              const active = activeView === view.id;
              const count = counts && view.id in counts ? counts[view.id as keyof typeof counts] : null;
              return (
                <Link
                  key={view.id}
                  to={savedViewHref(view.id, onIssues ? listQuery.projectId : null)}
                  aria-current={active ? "page" : undefined}
                  className={`${navItem} pl-9 ${active ? "bg-raised text-fg" : ""}`}
                >
                  <span className="flex-1">{view.label}</span>
                  {count !== null ? <span className="text-xs tabular-nums">{count}</span> : null}
                </Link>
              );
            })}
          </nav>

          {(projects?.projects.length ?? 0) > 0 ? (
            <nav aria-label="Projects" className="flex flex-col gap-0.5">
              <p className="px-2.5 pb-1 pt-3.5 text-xs font-medium text-muted">Projects</p>
              {projects!.projects.map((project) => {
                const selected = onIssues && listQuery.projectId === project.id;
                const href = `/errors?${serializeListQuery({ ...listQuery, projectId: project.id, q: "" }).toString()}`;
                return (
                  <Link key={project.id} to={href} className={`${navItem} pl-9 ${selected ? "text-fg" : ""}`}>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {perProject ? <span className="text-xs tabular-nums">{perProject.get(project.id) ?? 0}</span> : null}
                  </Link>
                );
              })}
            </nav>
          ) : null}

          <div className="min-h-4 flex-1" />

          <NavLink
            to="/settings"
            className={({ isActive }) => `${navItem} ${isActive || location.pathname.startsWith("/settings") ? "bg-raised text-fg" : ""}`}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Settings
          </NavLink>
          <ThemeSwitch />
          <div className="mt-2.5 flex items-center gap-2.5 border-t border-line pl-2.5 pt-2.5 text-[13px]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-[11px] font-semibold">
              {initials(user.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{user.name}</span>
              <span className="block text-xs capitalize text-muted">{user.role}</span>
            </span>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Log out" onClick={() => void onLogout()}>
              <LogOut className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1 px-6 pb-8 pt-5 max-[720px]:basis-full max-[720px]:px-4 max-[720px]:pt-4">
        {children}
      </main>
    </div>
  );
}
