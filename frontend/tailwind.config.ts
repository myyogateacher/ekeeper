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
        // "Inter Variable" is the family name @fontsource-variable/inter registers (imported once in main.tsx),
        // not "Inter": a font-family of plain "Inter" would match only a copy installed on the viewer's machine
        // and silently skip the self-hosted file. The system stack is the fallback while the file loads
        // (font-display: swap) and for any glyph outside the shipped subsets.
        sans: ["Inter Variable", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
