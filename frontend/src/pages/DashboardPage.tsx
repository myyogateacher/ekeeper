import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { MetricCard } from "@/components/MetricCard";
import { formatNumber } from "@/lib/utils";

export function DashboardPage() {
  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
  });

  const cards = data?.cards ?? [];
  const totalEvents = cards.reduce((sum, card) => sum + card.totalEvents7d, 0);
  const recurringGroups = cards.reduce((sum, card) => sum + card.recurringGroups7d, 0);
  const impactedUsers = cards.reduce((sum, card) => sum + card.impactedUsers7d, 0);

  return (
    <div className="space-y-6">
      <section className="glass-panel p-6">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">7 day oversight</p>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-3xl font-semibold text-white">Operational error command center</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Review trends, compare project health, and move from raw exceptions to grouped issues with full context.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Events" value={formatNumber(totalEvents)} secondary="Captured in the last 7 days" />
        <MetricCard label="Recurring groups" value={formatNumber(recurringGroups)} secondary="Clusters requiring attention" />
        <MetricCard label="Affected users" value={formatNumber(impactedUsers)} secondary="Distinct impacted identities" />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {cards.map((card) => (
          <div key={card.projectId} className="glass-panel p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Project</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">{card.projectName}</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs text-slate-200">
                {card.topGroupTitle ?? "No issue title yet"}
              </span>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Events</p>
                <p className="mt-2 text-2xl font-semibold text-white">{formatNumber(card.totalEvents7d)}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Groups</p>
                <p className="mt-2 text-2xl font-semibold text-white">{formatNumber(card.recurringGroups7d)}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Users</p>
                <p className="mt-2 text-2xl font-semibold text-white">{formatNumber(card.impactedUsers7d)}</p>
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
