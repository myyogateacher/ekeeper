export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatDate(value: string | null): string {
  if (!value) {
    return "N/A";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function trendTone(value: number): string {
  if (value > 0) {
    return "text-rose-200";
  }

  if (value < 0) {
    return "text-emerald-200";
  }

  return "text-slate-300";
}
