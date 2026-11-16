import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";

/**
 * Open and close behaviour shared by the owner picker and the status split button: a disclosure, a trigger
 * button that shows or hides a panel of plain buttons. Not an ARIA menu, which would promise arrow-key
 * navigation these panels do not implement; with plain buttons every item is reachable by Tab, which the
 * browser already does.
 *
 * What it adds on top of a boolean:
 * - Opening moves focus to the first button in the panel, so a keyboard user lands in it instead of having to
 *   Tab through whatever follows the trigger. `ready` holds that back for a panel whose items load after it
 *   opens (the owner list is fetched on open).
 * - Escape closes and returns focus to the trigger, so the user keeps their place.
 * - A pointer press outside, or Tab moving focus to another element, closes without moving focus.
 *
 * Spread `rootProps` on the element that wraps trigger and panel. It also sets data-popover-open, which the
 * issue list's J/K shortcut reads so the keys do not move the row cursor under an open panel.
 */
export function usePopover(ready = true) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (open && ready) {
      panel.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    }
  }, [open, ready]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const rootProps = {
    ref: root,
    "data-popover-open": open || undefined,
    // Only a real element receiving focus outside counts. Safari does not focus a button on click, so a click
    // on a panel item arrives here with relatedTarget null; closing on that would unmount the item before
    // its click fires.
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget as Node | null;
      if (open && next && !root.current?.contains(next)) setOpen(false);
    },
  };

  return { open, toggle: () => setOpen((value) => !value), close, rootProps, trigger, panel };
}
