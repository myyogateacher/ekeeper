import { useState } from "react";
import { currentTheme, setTheme, type Theme } from "@/lib/theme";

/** Light and Dark only; the first paint already follows the system until the user picks one. */
export function ThemeSwitch() {
  const [theme, setLocalTheme] = useState<Theme>(currentTheme);
  return (
    <div role="group" aria-label="Theme" className="mx-2.5 mt-2 inline-flex self-start overflow-hidden rounded-md border border-line">
      {(["light", "dark"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          className={`h-7 px-2.5 text-xs font-medium capitalize max-[720px]:h-10 ${
            theme === option ? "bg-raised text-fg" : "text-muted hover:text-fg"
          }`}
          onClick={() => {
            setTheme(option);
            setLocalTheme(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
