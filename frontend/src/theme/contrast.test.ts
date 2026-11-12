import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Reads the real tokens.css, so a palette edit that drops a pair under the bar fails here and not in a
// reviewer's eyes. The pair lists below are the foreground and background combinations the components put on
// screen (text-* over bg-*, and the tints from `bg-open/10` style classes); a pair that is not listed is not
// checked, which the last test guards for text colours by comparing against the classes the source uses.
// Ratios use the WCAG relative luminance formula. A tint is composited over its surface in gamma encoded sRGB,
// which is how a browser blends `rgb(r g b / 0.1)`.

type Rgb = [number, number, number];
type Theme = Record<string, Rgb>;

function readThemes(): { dark: Theme; light: Theme } {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  const themes: Record<string, Theme> = {};
  for (const [, selector, body] of css.matchAll(/(:root[^{]*)\{([^}]*)\}/g)) {
    const name = selector.includes('data-theme="light"') ? "light" : "dark";
    const tokens: Theme = {};
    for (const [, token, r, g, b] of body.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
      tokens[token] = [Number(r), Number(g), Number(b)];
    }
    themes[name] = tokens;
  }
  return { dark: themes.dark, light: themes.light };
}

const channel = (value: number) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  [0, 1, 2].map((i) => top[i] * alpha + under[i] * (1 - alpha)) as Rgb;

// Page, card and hovered or focused row: every text colour lands on one of these three.
const SURFACES = ["bg", "surface", "raised"] as const;
// Tint strengths: the components ship /10 (bg-open/10); the canvas draws 12%. Both must pass.
const TINTS = [0.1, 0.12];

function textFailures(theme: Theme, themeName: string): string[] {
  const failures: string[] = [];
  const check = (label: string, fg: Rgb, bg: Rgb, minimum: number) => {
    const value = ratio(fg, bg);
    if (value < minimum) failures.push(`${themeName} ${label}: ${value.toFixed(2)} < ${minimum}`);
  };
  for (const surface of SURFACES) {
    for (const text of ["fg", "muted", "accent", "fatal"]) {
      check(`${text} on ${surface}`, theme[text], theme[surface], 4.5);
    }
    // Tinted status and level tags sit on whichever surface the row is on.
    for (const text of ["open", "reopened", "closed", "fatal"]) {
      for (const alpha of TINTS) {
        check(`${text} on ${text} ${alpha * 100}% over ${surface}`, theme[text], over(theme[text], alpha, theme[surface]), 4.5);
      }
    }
  }
  check("fg on code", theme.fg, theme.code, 4.5);
  check("muted on code", theme.muted, theme.code, 4.5);
  check("fg on warn-bg", theme.fg, theme["warn-bg"], 4.5);
  check("accent-ink on accent (primary button)", theme["accent-ink"], theme.accent, 4.5);
  check("bg on fg (toast)", theme.bg, theme.fg, 4.5);
  // Non-text: chart bars (muted fill on the card) and the focus ring (accent outline) need 3:1.
  for (const surface of SURFACES) {
    check(`focus ring accent on ${surface}`, theme.accent, theme[surface], 3);
  }
  check("chart bar muted on surface", theme.muted, theme.surface, 3);
  return failures;
}

test("every text pair on screen is at least 4.5:1, and chart bars and the focus ring 3:1, in both themes", () => {
  const { dark, light } = readThemes();
  assert.deepEqual([...textFailures(dark, "dark"), ...textFailures(light, "light")], []);
});

// If the source starts using a text colour this file does not check (say text-warn-text), the test above
// stays green and proves nothing about it. Fail here instead so the new pair gets added to the lists.
test("every text colour token used in the source is covered by the contrast pairs", () => {
  const covered = new Set(["fg", "muted", "accent", "fatal", "open", "reopened", "closed", "accent-ink", "bg"]);
  const { dark } = readThemes();
  const tokenNames = new Set(Object.keys(dark));
  const used = new Set<string>();
  const root = new URL("../", import.meta.url);
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(tsx|css)$/.test(entry.name)) continue;
    const file = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const [, token] of file.matchAll(/\btext-([a-z]+(?:-[a-z]+)*)\b/g)) {
      if (tokenNames.has(token)) used.add(token);
    }
  }
  assert.deepEqual([...used].filter((token) => !covered.has(token)), []);
});
