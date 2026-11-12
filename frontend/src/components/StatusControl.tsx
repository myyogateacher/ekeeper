import { ChevronDown } from "lucide-react";
import type { IssueState } from "@ekeeper/shared";
import { statusActions } from "@/lib/issue-detail";
import { usePopover } from "@/components/usePopover";

interface StatusControlProps {
  state: IssueState;
  pending: boolean;
  onChange: (state: IssueState) => void;
}

/**
 * The issue header's status control (plan D8). The primary button is the common move for the current state;
 * a secondary move, which exists only for a reopened issue ("Mark as open"), sits in a menu on a split
 * button so a one-click Close is never one misclick from a rarer action. Open and closed issues render a
 * single button with no chevron, because an empty menu would be a control that does nothing.
 */
export function StatusControl({ state, pending, onChange }: StatusControlProps) {
  const { primary, secondary } = statusActions(state);
  const popover = usePopover();
  const tone = primary.state === "closed" ? "btn-primary" : "";

  if (!secondary) {
    return (
      <button type="button" className={`btn ${tone}`} disabled={pending} onClick={() => onChange(primary.state)}>
        {primary.label}
      </button>
    );
  }

  return (
    <div {...popover.rootProps} className="relative inline-flex">
      <button type="button" className={`btn rounded-r-none ${tone}`} disabled={pending} onClick={() => onChange(primary.state)}>
        {primary.label}
      </button>
      <button
        ref={popover.trigger}
        type="button"
        className={`btn btn-icon rounded-l-none border-l border-l-bg/30 ${tone}`}
        aria-label="More status options"
        aria-expanded={popover.open}
        disabled={pending}
        onClick={popover.toggle}
      >
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      {popover.open ? (
        <div ref={popover.panel} role="group" aria-label="Other status" className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-line bg-surface p-1.5 shadow-lg">
          <button
            type="button"
            className="flex h-9 w-full items-center rounded-md px-2 text-left text-[13px] hover:bg-raised max-[720px]:h-11"
            onClick={() => {
              popover.close();
              onChange(secondary.state);
            }}
          >
            {secondary.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
