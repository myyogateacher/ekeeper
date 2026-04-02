import { trendTone } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: string;
  secondary: string;
  trend?: number;
}

export function MetricCard({ label, value, secondary, trend }: MetricCardProps) {
  return (
    <div className="glass-panel p-5">
      <p className="text-xs uppercase tracking-[0.25em] text-slate-400">{label}</p>
      <div className="mt-6 flex items-end justify-between gap-4">
        <div>
          <p className="text-3xl font-semibold text-white">{value}</p>
          <p className="mt-1 text-sm text-slate-300">{secondary}</p>
        </div>
        {typeof trend === "number" ? (
          <p className={`text-sm font-medium ${trendTone(trend)}`}>{trend > 0 ? `+${trend}%` : `${trend}%`}</p>
        ) : null}
      </div>
    </div>
  );
}
