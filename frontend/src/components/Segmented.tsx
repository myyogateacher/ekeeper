import type { Ref } from "react";

/**
 * A segmented control: a row of buttons where exactly one is pressed. `role="group"` plus `aria-pressed` and not
 * a radiogroup or tablist, because each option is a plain button reached with Tab and nothing here moves focus
 * with arrow keys. The theme switch and the stack trace's In app / All frames switch are both this, so the
 * height, the 44px touch size under 720px and the pressed look are written once.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className = "",
  ref,
}: {
  /** The group's accessible name, e.g. "Theme" or "Frames shown". */
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** The group element, for a caller that has to move focus into it (React 19 passes ref as a prop). */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} role="group" aria-label={label} className={`inline-flex overflow-hidden rounded-md border border-line ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={`h-7 whitespace-nowrap px-2.5 text-xs font-medium max-[720px]:h-11 max-[720px]:min-w-11 ${
            value === option.value ? "bg-raised text-fg" : "text-muted hover:text-fg"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
