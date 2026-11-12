import type { ComponentType } from "react";
import { NavLink, Navigate, useLocation, useParams } from "react-router-dom";
import { SETTINGS_SECTIONS, visibleSettingsSections, type SettingsSectionId } from "@/lib/permissions";
import { useMe } from "@/components/session";
import { ProjectsSection } from "./settings/ProjectsSection";
import { MembersSection } from "./settings/MembersSection";
import { SourceMapsSection } from "./settings/SourceMapsSection";
import { GithubSection } from "./settings/GithubSection";
import { McpSection } from "./settings/McpSection";
import { ServerSection } from "./settings/ServerSection";

const SECTION_PAGES: Record<SettingsSectionId, ComponentType> = {
  projects: ProjectsSection,
  members: MembersSection,
  "source-maps": SourceMapsSection,
  github: GithubSection,
  mcp: McpSection,
  server: ServerSection,
};

/**
 * One route, /settings/:section. The sub-nav and the guard read the same visibleSettingsSections list, so
 * a section a role cannot load is neither linked nor rendered: an unknown or hidden section redirects to
 * Projects instead of showing a page whose calls would 403.
 */
export function SettingsPage() {
  const me = useMe();
  const { section } = useParams();
  const { search } = useLocation();
  const visible = visibleSettingsSections(me);
  const current = visible.find((id) => id === section);
  if (!current) {
    return <Navigate to={`/settings/projects${search}`} replace />;
  }
  const Section = SECTION_PAGES[current];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="page-title">Settings</h1>
      <div className="grid gap-6 [grid-template-columns:180px_minmax(0,1fr)] max-[860px]:[grid-template-columns:minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="flex flex-col gap-0.5 max-[860px]:flex-row max-[860px]:flex-wrap">
          {SETTINGS_SECTIONS.filter((entry) => visible.includes(entry.id)).map((entry) => (
            <NavLink
              key={entry.id}
              // Keeps ?project= so moving between project scoped sections stays on the same project.
              to={`/settings/${entry.id}${search}`}
              className={({ isActive }) =>
                `flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] max-[720px]:h-11 ${
                  isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised hover:text-fg"
                }`
              }
            >
              {entry.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          <Section />
        </div>
      </div>
    </div>
  );
}
