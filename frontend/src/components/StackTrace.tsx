import { useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Plus } from "lucide-react";
import type { ErrorEventDetail } from "@ekeeper/shared";
import { framesCrashFirst } from "@/lib/issue-detail";
import { stackView, type ContextLine, type FrameRow } from "@/lib/stack-trace";
import { Segmented } from "@/components/Segmented";

type FramesShown = "app" | "all";

const FRAME_OPTIONS: ReadonlyArray<{ value: FramesShown; label: string }> = [
  { value: "app", label: "In app" },
  { value: "all", label: "All frames" },
];

/**
 * The issue page's stack trace: crash site first, framework frames folded behind "In app", and the source
 * lines around each frame that has them. Every rule (what is framework, what folds, which frame opens, which
 * lines draw) is in lib/stack-trace.ts; this only draws its rows.
 *
 * The In app / All frames choice is local state, not the URL: it is a reading preference for this card, not
 * part of which issue or event is shown, so it does not belong in a shared link or the back stack. It also
 * survives switching to the next event of the same issue, because this component stays mounted across that.
 */
export function StackTrace({ event }: { event: ErrorEventDetail }) {
  const [shown, setShown] = useState<FramesShown>("app");
  const switchRef = useRef<HTMLDivElement>(null);
  const frames = useMemo(() => framesCrashFirst(event.stacktrace, event.exception), [event.stacktrace, event.exception]);
  const { rows, canToggle } = useMemo(() => stackView(frames, shown === "all"), [frames, shown]);

  // The folded row unmounts the moment it is activated, which drops keyboard focus to the page. Focus goes to
  // the All frames button instead, the same control the row stands for. At click time the switch still reads
  // "In app", so All frames is the one button that is not pressed.
  const showAllFrames = () => {
    setShown("all");
    switchRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')?.focus();
  };

  return (
    <section className="card" aria-labelledby="stacktrace-title">
      <div className="card-head">
        <h2 id="stacktrace-title" className="m-0 text-sm font-semibold">Stack trace</h2>
        {event.sourceMapApplied ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <Check className="h-3.5 w-3.5" aria-hidden /> Source mapped, release {event.sourceMapRelease ?? "unknown"}
          </span>
        ) : null}
        {canToggle ? <Segmented ref={switchRef} label="Frames shown" options={FRAME_OPTIONS} value={shown} onChange={setShown} className="ml-auto" /> : null}
      </div>
      {!event.sourceMapApplied && frames.length > 0 ? (
        <p className="warn-box m-3">
          No source map matched this event, so frames show the minified file and position. Upload source maps for this release in Settings.
        </p>
      ) : null}
      {frames.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">This event has no stack trace.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {rows.map((row) => (
            // The event id is in the key so an open or closed frame is forgotten when the next event loads,
            // while a frame keeps its state when only the In app / All frames choice changes.
            <li key={`${event.eventId}:${row.kind}:${row.index}`} className="border-b border-line last:border-b-0">
              {row.kind === "collapsed" ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-muted hover:bg-raised hover:text-fg max-[720px]:min-h-11"
                  onClick={showAllFrames}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {row.label}
                </button>
              ) : (
                <Frame row={row} />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Frame({ row }: { row: FrameRow }) {
  const header = (
    <>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
      <span className={row.kind === "framework" ? "font-medium" : "font-semibold"}>{row.fn}</span>
      <span className="mono min-w-0 break-all text-muted">{row.location}</span>
      {row.kind === "framework" ? <span className="rounded border border-line px-1.5 text-[11px] font-medium leading-4">framework</span> : null}
      {row.mapped && row.kind === "frame" ? <span className="tag bg-closed/10 text-closed">mapped</span> : null}
    </>
  );
  const headerClass = "flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-[13px]";

  if (row.kind === "framework") {
    return <div className={`${headerClass} text-muted`}>{header}</div>;
  }
  if (!row.context) {
    return <div className={headerClass}>{header}</div>;
  }
  return (
    <details className="group" open={row.open}>
      <summary className={`${headerClass} cursor-pointer list-none hover:bg-raised max-[720px]:min-h-11 [&::-webkit-details-marker]:hidden`}>{header}</summary>
      <SourceLines lines={row.context} name={row.fn} />
    </details>
  );
}

/**
 * Numbered source lines in a 56px gutter, the crash line tinted with a 3px bar on its left. The block scrolls
 * sideways on its own so a long line never widens the page (register 27), and is focusable so a keyboard user
 * can scroll it. The inner box is as wide as the longest line, so the tint and the bar run the full scroll
 * width instead of stopping at the visible edge. Line numbers do not select, so a copied block is code only.
 */
function SourceLines({ lines, name }: { lines: ContextLine[]; name: string }) {
  return (
    <div role="region" aria-label={`Source lines for ${name}`} tabIndex={0} className="mono overflow-x-auto border-t border-line bg-code py-1.5">
      <div className="w-max min-w-full">
        {lines.map((line) => (
          <div
            key={line.number}
            className={`grid whitespace-pre [grid-template-columns:56px_minmax(0,1fr)] ${line.crash ? "bg-fatal/15 shadow-[inset_3px_0_0_rgb(var(--fatal))]" : ""}`}
          >
            <span className={`select-none pr-4 text-right ${line.crash ? "text-fg" : "text-muted"}`}>{line.number}</span>
            <span className="pr-4">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
