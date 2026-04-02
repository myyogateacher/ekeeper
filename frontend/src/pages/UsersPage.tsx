import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, roleOptions } from "@/lib/api";
import type { UserRole } from "@ekeeper/shared";

type UserForm = {
  name: string;
  email: string;
  avatarUrl: string;
  role: UserRole;
  status: "active" | "disabled";
};

const emptyUser: UserForm = { name: "", email: "", avatarUrl: "", role: "viewer", status: "active" };

export function UsersPage() {
  const queryClient = useQueryClient();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyUser);
  const { data } = useQuery({ queryKey: ["users"], queryFn: api.users });

  const users = useMemo(() => data?.users ?? [], [data]);
  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;

  const createUser = useMutation({
    mutationFn: api.createUser,
    onSuccess: async () => {
      setForm(emptyUser);
      setSelectedUserId(null);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const updateUser = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: Partial<UserForm> }) =>
      api.updateUser(userId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const deleteUser = useMutation({
    mutationFn: api.deleteUser,
    onSuccess: async (_, userId) => {
      if (selectedUserId === userId) {
        setSelectedUserId(null);
        setForm(emptyUser);
      }
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  function selectUser(userId: string) {
    const user = users.find((entry) => entry.id === userId);
    if (!user) {
      return;
    }
    setSelectedUserId(userId);
    setForm({
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl ?? "",
      role: user.role,
      status: user.status,
    });
  }

  function resetForm() {
    setSelectedUserId(null);
    setForm(emptyUser);
  }

  return (
    <div className="space-y-6">
      <section className="glass-panel p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Access control</p>
          <h2 className="mt-4 text-3xl font-semibold text-white">Users, profiles, and access grants</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Provision identities, update workspace roles, and prepare users for project-level access assignments.
          </p>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="glass-panel p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Users</h3>
              <p className="mt-1 text-sm text-slate-300">Select a user to edit their profile and workspace access.</p>
            </div>
            <button className="button-secondary" type="button" onClick={resetForm}>
              Add new user
            </button>
          </div>

          <div className="mt-5 space-y-3">
            {users.map((user) => {
              const isActive = user.id === selectedUserId;
              return (
                <div
                  key={user.id}
                  className={`cursor-pointer rounded-3xl border p-4 transition ${
                    isActive
                      ? "border-cyan-300/30 bg-cyan-300/10"
                      : "border-white/10 bg-slate-950/20 hover:bg-white/5"
                  }`}
                  tabIndex={0}
                  onClick={() => selectUser(user.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectUser(user.id);
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      {user.avatarUrl ? (
                        <img
                          src={user.avatarUrl}
                          alt={user.name}
                          className="h-11 w-11 shrink-0 rounded-full border border-white/10 object-cover"
                        />
                      ) : (
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm font-semibold text-slate-200">
                          {user.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-white">{user.name}</p>
                        <p className="mt-1 break-all text-sm text-slate-300">{user.email}</p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{user.role}</p>
                      <p className="mt-1 text-xs capitalize text-slate-300">{user.status}</p>
                    </div>
                  </div>
                </div>
              );
            })}
            {users.length === 0 ? (
              <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-4 text-sm text-slate-300">
                No users created yet.
              </div>
            ) : null}
          </div>
        </div>

        <div className="glass-panel p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white">
                {selectedUser ? "Edit user" : "Add user"}
              </h3>
              <p className="mt-1 text-sm text-slate-300">
                {selectedUser
                  ? "Update the selected user’s role, status, or profile details."
                  : "Create a new user who can later be assigned to projects."}
              </p>
            </div>
            {selectedUser ? (
              <button className="button-secondary" type="button" onClick={resetForm}>
                Cancel edit
              </button>
            ) : null}
          </div>

          <form
            className="mt-5 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (selectedUser) {
                updateUser.mutate({
                  userId: selectedUser.id,
                  payload: {
                    name: form.name,
                    avatarUrl: form.avatarUrl,
                    role: form.role,
                    status: form.status,
                  },
                });
                return;
              }

              createUser.mutate(form);
            }}
          >
            <input
              className="input"
              placeholder="Name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
            <input
              className="input"
              placeholder="Email"
              value={form.email}
              disabled={Boolean(selectedUser)}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
            />
            <input
              className="input"
              placeholder="Avatar URL"
              value={form.avatarUrl}
              onChange={(event) => setForm((current) => ({ ...current, avatarUrl: event.target.value }))}
            />
            <select
              className="input"
              value={form.role}
              onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as typeof form.role }))}
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={form.status}
              onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as typeof form.status }))}
            >
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>

            <div className="flex flex-wrap gap-3 pt-2">
              <button className="button-primary" type="submit" disabled={createUser.isPending || updateUser.isPending}>
                {selectedUser ? "Save changes" : "Add user"}
              </button>
              {selectedUser ? (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => deleteUser.mutate(selectedUser.id)}
                  disabled={deleteUser.isPending}
                >
                  Remove user
                </button>
              ) : null}
            </div>

            {selectedUser ? (
              <p className="text-sm text-slate-300">
                Email stays locked during edit so identity remains stable.
              </p>
            ) : null}
            {createUser.error ? <p className="text-sm text-rose-200">{createUser.error.message}</p> : null}
            {updateUser.error ? <p className="text-sm text-rose-200">{updateUser.error.message}</p> : null}
            {deleteUser.error ? <p className="text-sm text-rose-200">{deleteUser.error.message}</p> : null}
          </form>
        </div>
      </section>
    </div>
  );
}
