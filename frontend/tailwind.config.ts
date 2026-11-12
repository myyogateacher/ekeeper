import type { Config } from "tailwindcss";

// Colours come only from src/theme/tokens.css. The palette is replaced, not extended, so a stray
// Tailwind palette class (text-slate-300, bg-cyan-400) compiles to nothing instead of painting one theme.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      bg: token("bg"),
      surface: token("surface"),
      raised: token("raised"),
      line: token("line"),
      fg: token("fg"),
      muted: token("muted"),
      accent: token("accent"),
      "accent-ink": token("accent-ink"),
      open: token("open"),
      reopened: token("reopened"),
      closed: token("closed"),
      fatal: token("fatal"),
      "warn-text": token("warn-text"),
      code: token("code"),
      "dot-fatal": token("dot-fatal"),
      "dot-error": token("dot-error"),
      "dot-warning": token("dot-warning"),
      "dot-info": token("dot-info"),
      "warn-bg": token("warn-bg"),
      "warn-line": token("warn-line"),
    },
    extend: {
      fontFamily: {
        // Inter when the machine has it, otherwise the system UI face. Self-hosting Inter needs a new
        // dependency, which this change does not add (see the PR body).
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
