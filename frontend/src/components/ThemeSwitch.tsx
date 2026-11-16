import { useState } from "react";
import { currentTheme, setTheme, type Theme } from "@/lib/theme";
import { Segmented } from "@/components/Segmented";

const OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Light and Dark only; the first paint already follows the system until the user picks one. */
export function ThemeSwitch() {
  const [theme, setLocalTheme] = useState<Theme>(currentTheme);
  return (
    <Segmented
      label="Theme"
      options={OPTIONS}
      value={theme}
      className="mx-2.5 mt-2 self-start"
      onChange={(next) => {
        setTheme(next);
        setLocalTheme(next);
      }}
    />
  );
}
