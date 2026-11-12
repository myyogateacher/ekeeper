import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { User, UserRole } from "@ekeeper/shared";
import { api, roleOptions } from "@/lib/api";
import { isAdmin } from "@/lib/permissions";
import { useMe } from "@/components/session";
import { initials } from "@/components/AssignMenu";
import { EmptyState } from "@/components/EmptyState";
import { SectionHeader } from "./shared";

type UserForm = { name: string; email: string; avatarUrl: string; role: UserRole; status: "active" | "disabled" };

const emptyUser: UserForm = { name: "", email: "", avatarUrl: "", role: "viewer", status: "active" };

/** Workspace users. Listed for admin and viewer (routes/api.ts:474); add, edit and remove are admin only. */
export function MembersSection() {
  const me = useMe();
  const admin = isAdmin(me);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["users"], queryFn: api.users });
  // null: form closed. "new": adding. A user id: editing that user.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(emptyUser);
  const users = data?.users ?? [];

  const done = async () => {
    setEditing(null);
    setForm(emptyUser);
    await queryClient.invalidateQueries({ queryKey: ["users"] });
  };
  const createUser = useMutation({ mutationFn: api.createUser, onSuccess: done });
  const updateUser = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: Partial<UserForm> }) => api.updateUser(userId, payload),
    onSuccess: done,
  });
  const deleteUser = useMutation({ mutationFn: api.deleteUser, onSuccess: done });

  const open = (user: User | null) => {
    setEditing(user?.id ?? "new");
    setForm(user ? { name: user.name, email: user.email, avatarUrl: user.avatarUrl ?? "", role: user.role, status: user.status } : emptyUser);
  };
  const editingUser = users.find((user) => user.id === editing) ?? null;
  const pending = createUser.isPending || updateUser.isPending || deleteUser.isPending;

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Members"
        action={
          admin ? (
            <button type="button" className="btn btn-primary" onClick={() => open(null)}>
              Add member
            </button>
          ) : null
        }
      >
        Everyone who can sign in. Admins manage the workspace, managers can close and assign issues in projects where they are a
        manager, viewers read.
      </SectionHeader>

      {admin && editing ? (
        <form
          className="card grid gap-3 p-4 [grid-template-columns:repeat(2,minmax(0,1fr))] max-[720px]:[grid-template-columns:minmax(0,1fr)]"
          onSubmit={(event) => {
            event.preventDefault();
            if (editingUser) {
              const { email: _email, ...payload } = form;
              updateUser.mutate({ userId: editingUser.id, payload });
            } else {
              createUser.mutate(form);
            }
          }}
        >
          <h3 className="m-0 text-sm font-semibold [grid-column:1/-1]">{editingUser ? `Edit ${editingUser.name}` : "Add member"}</h3>
          <label className="flex flex-col">
            <span className="label">Name</span>
            <input className="input" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="flex flex-col">
            <span className="label">Email{editingUser ? " (fixed, it is the sign-in identity)" : ""}</span>
            <input
              className="input"
              type="email"
              required
              disabled={Boolean(editingUser)}
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </label>
          <label className="flex flex-col">
            <span className="label">Role</span>
            <select className="input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}>
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="label">Status</span>
            <select
              className="input"
              value={form.status}
              onChange={(event) => setForm({ ...form, status: event.target.value as UserForm["status"] })}
            >
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label className="flex flex-col [grid-column:1/-1]">
            <span className="label">Avatar URL (optional)</span>
            <input className="input" value={form.avatarUrl} onChange={(event) => setForm({ ...form, avatarUrl: event.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2 [grid-column:1/-1]">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {editingUser ? "Save changes" : "Add member"}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            {editingUser ? (
              <button
                type="button"
                className="btn ml-auto"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Remove ${editingUser.name}? They can no longer sign in.`)) deleteUser.mutate(editingUser.id);
                }}
              >
                Remove member
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      <section className="card">
        {users.length === 0 && !isLoading ? (
          <EmptyState title="No members yet" />
        ) : (
          <ul className="m-0 list-none p-0">
            {users.map((user) => (
              <li key={user.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-xs font-semibold">
                  {initials(user.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{user.name}</div>
                  <div className="truncate text-xs text-muted">{user.email}</div>
                </div>
                <span className="tag bg-raised capitalize text-fg">{user.role}</span>
                {user.status === "disabled" ? <span className="tag text-muted ring-1 ring-inset ring-line">disabled</span> : null}
                {admin ? (
                  <button type="button" className="btn btn-sm" aria-label={`Edit ${user.name}`} onClick={() => open(user)}>
                    Edit
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
