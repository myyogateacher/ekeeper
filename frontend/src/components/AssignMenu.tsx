import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useIssueWorkflow } from "@/components/workflow";

interface AssignMenuProps {
  projectId: string;
  groupId: string;
  meId: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
  /** "avatar" in list rows, "button" in the issue header. */
  variant: "avatar" | "button";
}

/**
 * Owner picker. Only project members can be assigned (the backend rejects anyone else with 400,
 * backend/src/routes/api.ts:939-947), so the list comes from that project's assignees, loaded when the
 * menu opens. "Assign to me" appears only when the viewer is one of them.
 */
export function AssignMenu({ projectId, groupId, meId, assignedUserId, assignedUserName, variant }: AssignMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const workflow = useIssueWorkflow();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["error-assignees", projectId],
    queryFn: () => api.errorAssignees(projectId),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const users = data?.users ?? [];
  const me = users.find((user) => user.id === meId);
  const others = users.filter((user) => user.id !== meId);
  const assign = (userId: string | null) => {
    setOpen(false);
    workflow.mutate({ projectId, groupId, payload: { assignedUserId: userId } });
  };

  const label = assignedUserName ? `Owner ${assignedUserName}, change owner` : "Unassigned, assign an owner";

  return (
    <div ref={root} className="relative" data-popover-open={open || undefined}>
      {variant === "avatar" ? (
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          title={assignedUserName ?? "Unassigned"}
          disabled={workflow.isPending}
          onClick={() => setOpen((value) => !value)}
          className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold max-[720px]:h-8 max-[720px]:w-8 ${
            assignedUserName ? "border border-line bg-raised text-fg" : "border border-dashed border-muted text-muted"
          }`}
        >
          {assignedUserName ? initials(assignedUserName) : "+"}
        </button>
      ) : (
        <button type="button" className="btn" aria-expanded={open} disabled={workflow.isPending} onClick={() => setOpen((value) => !value)}>
          {assignedUserName ? `Owner: ${assignedUserName}` : "Assign"}
        </button>
      )}
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-line bg-surface p-1.5 shadow-lg">
          {isLoading ? <p className="px-2 py-2 text-[13px] text-muted">Loading members</p> : null}
          {isError ? <p className="px-2 py-2 text-[13px] text-fatal">Couldn't load members</p> : null}
          {me ? <MenuItem label="Assign to me" initials={initials(me.name)} active={assignedUserId === me.id} onClick={() => assign(me.id)} /> : null}
          {others.map((user) => (
            <MenuItem key={user.id} label={user.name} initials={initials(user.name)} active={assignedUserId === user.id} onClick={() => assign(user.id)} />
          ))}
          {!isLoading && !isError && users.length === 0 ? (
            <p className="px-2 py-2 text-[13px] text-muted">No members in this project yet. An admin can add them.</p>
          ) : null}
          {assignedUserId ? <MenuItem label="Remove owner" initials="" active={false} onClick={() => assign(null)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ label, initials: letters, active, onClick }: { label: string; initials: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-raised max-[720px]:h-11 ${active ? "bg-raised" : ""}`}
    >
      {letters ? (
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-raised text-[11px] font-semibold">{letters}</span>
      ) : (
        <span className="w-6" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
