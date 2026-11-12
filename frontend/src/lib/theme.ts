// The theme is resolved before React loads, by the inline script in frontend/index.html, so the first
// paint is never the wrong theme. That script owns the rule (a stored choice wins, else the system
// preference); this module only reads the result and writes a new choice. The storage key is spelled in
// both places: change one, change the other.
export const THEME_STORAGE_KEY = "ekeeper:theme";

export type Theme = "light" | "dark";

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    // Storage blocked: the switch still applies for this page view, and the next load follows the system.
    console.warn("Could not save the theme choice:", error);
  }
}
