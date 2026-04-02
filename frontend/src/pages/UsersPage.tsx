import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, roleOptions } from "@/lib/api";
import { DataTable } from "@/components/DataTable";

const emptyUser = { name: "", email: "", avatarUrl: "", role: "viewer" as const, status: "active" as const };

export function UsersPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyUser);
  const { data } = useQuery({ queryKey: ["users"], queryFn: api.users });

  const createUser = useMutation({
    mutationFn: api.createUser,
    onSuccess: async () => {
      setForm(emptyUser);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const deleteUser = useMutation({
    mutationFn: api.deleteUser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  return (
    <div className="space-y-6">
      <section className="glass-panel p-6">
        <div className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Access control</p>
            <h2 className="mt-4 text-3xl font-semibold text-white">Users, profiles, and access grants</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              Provision identities, set workspace roles, and prepare users for project-level access assignments.
            </p>
          </div>
          <form
            className="grid gap-3 rounded-3xl border border-white/10 bg-slate-950/20 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              createUser.mutate(form);
            }}
          >
            <input className="input" placeholder="Name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            <input className="input" placeholder="Email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
            <input className="input" placeholder="Avatar URL" value={form.avatarUrl} onChange={(event) => setForm((current) => ({ ...current, avatarUrl: event.target.value }))} />
            <select className="input" value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as typeof form.role }))}>
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button className="button-primary" type="submit">
              Add user
            </button>
          </form>
        </div>
      </section>

      <DataTable headers={["User", "Role", "Status", "Actions"]}>
        {(data?.users ?? []).map((user) => (
          <tr key={user.id} className="text-slate-200">
            <td className="px-5 py-4">
              <div>
                <p className="font-medium text-white">{user.name}</p>
                <p className="text-sm text-slate-300">{user.email}</p>
              </div>
            </td>
            <td className="px-5 py-4 capitalize">{user.role}</td>
            <td className="px-5 py-4 capitalize">{user.status}</td>
            <td className="px-5 py-4">
              <button className="button-secondary" onClick={() => deleteUser.mutate(user.id)}>
                Remove
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
