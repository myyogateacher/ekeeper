// Literal class names, not `bg-dot-${level}`: Tailwind only generates classes it can find whole in the source.
const DOT_CLASS: Record<string, string> = {
  fatal: "bg-dot-fatal",
  error: "bg-dot-error",
  warning: "bg-dot-warning",
  info: "bg-dot-info",
  debug: "bg-dot-info",
};

/** Colour is never the only signal: every caller prints the level as text beside the dot. */
export function SeverityDot({ level, className = "" }: { level: string; className?: string }) {
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[level] ?? DOT_CLASS.error} ${className}`} />;
}
