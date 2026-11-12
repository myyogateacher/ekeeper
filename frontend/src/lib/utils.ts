import { formatAbsolute } from "@/lib/time";

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/** Kept so existing callers move to the zone-aware parser without each changing; see lib/time.ts. */
export function formatDate(value: string | null): string {
  return formatAbsolute(value);
}
