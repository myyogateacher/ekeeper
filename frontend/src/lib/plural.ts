/**
 * The noun for a count: "issue" for exactly one, "issues" for everything else, zero included. Callers print
 * the number themselves (often bold, with thousands separators), so this returns only the word. Regular
 * plurals only; pass `plural` for any noun that is not singular plus "s".
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
