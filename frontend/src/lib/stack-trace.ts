// Pure rules behind the stack trace card (components/StackTrace.tsx) and the crash line under the issue title:
// which frames count as framework code, how a run of them collapses, and the numbered source lines.
//
// Every field read here is untrusted JSON. A public DSN can send any shape, and the backend leaves what an
// unmapped frame carried untouched (backend/src/lib/stack-frames.ts), so each field is type checked before it
// can reach the screen and a field of the wrong shape reads as absent, never as a throw (defect register 88:
// one such event blanked the whole app). The framework rule itself lives only in the backend, which sets
// `in_app: false`; this file reads that flag and never re-derives it from a path (defect register 5).
import { displayText, type Frame } from "./issue-detail.ts";
import { pluralize } from "./plural.ts";

// What the backend produces for a source mapped frame (CONTEXT_LINES_EACH_SIDE and MAX_CONTEXT_LINE_LENGTH in
// backend/src/lib/stack-frames.ts), repeated rather than imported because here they bound what an UNMAPPED frame
// may carry: the backend passes the SDK's own lines through, and a DSN holder can send thousands of them. Using
// the backend's numbers makes mapped and unmapped frames read the same and caps the rows one frame can add.
const CONTEXT_LINES_EACH_SIDE = 3;
const MAX_LINE_LENGTH = 300;

// Names and paths in a header row are cut at the same 2048 the backend cuts a filename at before matching it
// (MAX_FILENAME_LENGTH in stack-frames.ts). Ingest stores a payload of any size, so an uncut function name is
// a megabyte of text per frame in the page.
const MAX_HEADER_TEXT_LENGTH = 2048;

// npm's own limit on a package name, so no real name is cut.
const MAX_PACKAGE_NAME_LENGTH = 214;

// Package names listed in "Show 4 framework frames (react-dom, scheduler)". The row stays one line on a typical
// stack; the full list is one click away under All frames. Past this it reads "+2 more".
const MAX_PACKAGES_SHOWN = 4;

const clip = (text: string, max: number) => text.slice(0, max);
const shown = (value: unknown) => clip(displayText(value), MAX_HEADER_TEXT_LENGTH);

export interface ContextLine {
  number: number;
  text: string;
  /** The line the frame points at; drawn with the fatal tint and a bar. */
  crash: boolean;
}

/** The nearest lines on one side of the crash line, or none at all when any of them is not a string. */
function nearestLines(value: unknown, side: "before" | "after", limit: number): string[] {
  if (!Array.isArray(value) || limit < 1) return [];
  // Slice before checking so a hostile array of a million entries costs a slice, not a scan; entries outside
  // the window are never drawn, so they never need to be valid.
  const kept = side === "before" ? value.slice(-limit) : value.slice(0, limit);
  // One bad entry drops the whole side instead of being skipped: skipping would shift every line number after it.
  return kept.every((line) => typeof line === "string") ? kept.map((line) => clip(line, MAX_LINE_LENGTH)) : [];
}

/**
 * The numbered lines to draw under a frame header, or null when the frame has no usable source. Needs a
 * positive integer `lineno` (a string "12" is refused: the number is what the gutter prints and the crash
 * line is placed by it) and a string `context_line`. `pre_context` and `post_context` are optional and each
 * is used only if it is an array of strings. Before-lines are numbered backwards from `lineno`, so the array
 * is cut to the lines nearest the crash and never to more than exist above line 1.
 */
export function frameContext(frame: Frame): ContextLine[] | null {
  const { lineno, context_line: crashText } = frame;
  if (typeof lineno !== "number" || !Number.isSafeInteger(lineno) || lineno < 1 || typeof crashText !== "string") {
    return null;
  }
  const before = nearestLines(frame.pre_context, "before", Math.min(CONTEXT_LINES_EACH_SIDE, lineno - 1));
  const after = nearestLines(frame.post_context, "after", CONTEXT_LINES_EACH_SIDE);
  return [
    ...before.map((text, index) => ({ number: lineno - before.length + index, text, crash: false })),
    { number: lineno, text: clip(crashText, MAX_LINE_LENGTH), crash: true },
    ...after.map((text, index) => ({ number: lineno + 1 + index, text, crash: false })),
  ];
}

/**
 * Which frames sit behind the In app / All frames switch. Only an explicit boolean `in_app === false` marks
 * framework code: "false", 0 and null are the sender's junk and stay in app, so junk can hide a frame only
 * by being exactly the value the backend writes. The switch exists only when it has something to switch
 * between, at least one framework frame and at least one in app frame. An event whose frames are ALL framework
 * (a server error raised wholly inside a library) shows every frame and no switch, which is why the flags are
 * all false then: hiding every frame would leave an empty card.
 */
function frameworkFlags(frames: Frame[]): { flags: boolean[]; canToggle: boolean } {
  const flags = frames.map((frame) => frame.in_app === false);
  const canToggle = flags.includes(true) && flags.includes(false);
  return { flags: canToggle ? flags : flags.map(() => false), canToggle };
}

export interface FrameRow {
  /** "framework" is the muted row All frames draws for a library frame: header only, never source lines. */
  kind: "frame" | "framework";
  /** Position in crash-first order, unique across rows, so it is the React key. */
  index: number;
  fn: string;
  /** "src/a.ts:142:38". */
  location: string;
  mapped: boolean;
  context: ContextLine[] | null;
  /** True for exactly one row: the first frame that has source lines. */
  open: boolean;
}

export interface CollapsedRow {
  kind: "collapsed";
  index: number;
  /** "Show 4 framework frames (react-dom, scheduler)". */
  label: string;
}

export type StackRow = FrameRow | CollapsedRow;

export interface StackView {
  rows: StackRow[];
  canToggle: boolean;
}

/** "Show 4 framework frames (react-dom, scheduler)"; no brackets when none of the frames names a package. */
export function collapsedLabel(count: number, packages: string[]): string {
  const listed = packages.slice(0, MAX_PACKAGES_SHOWN);
  const hidden = packages.length - listed.length;
  const names = [...listed, ...(hidden > 0 ? [`+${hidden} more`] : [])].join(", ");
  return `Show ${count} framework ${pluralize(count, "frame")}${names ? ` (${names})` : ""}`;
}

function packageName(frame: Frame): string | null {
  return typeof frame.package === "string" && frame.package !== "" ? clip(frame.package, MAX_PACKAGE_NAME_LENGTH) : null;
}

/** ":12" for a position part, nothing for an absent one. displayText turns null into "", which must not leave a dangling ":". */
function positionPart(value: unknown): string {
  const text = shown(value);
  return text ? `:${text}` : "";
}

function frameRow(frame: Frame, index: number, kind: FrameRow["kind"]): FrameRow {
  return {
    kind,
    index,
    fn: shown(frame.function) || "?",
    location: (shown(frame.filename) || "unknown file") + positionPart(frame.lineno) + positionPart(frame.colno),
    mapped: frame.deobfuscated === true,
    context: kind === "framework" ? null : frameContext(frame),
    open: false,
  };
}

/**
 * The rows of the stack trace for the crash-first `frames` (framesCrashFirst). In app view each run of
 * consecutive framework frames becomes one collapsed row, in the place the run occupies, so the trace still
 * reads as one call path with the library stretches folded. All frames view draws every framework frame as its
 * own muted row. Only the first frame that has source lines is open by default: one open block shows where it
 * broke without pushing the other frames off screen.
 */
export function stackView(frames: Frame[], showAll: boolean): StackView {
  const { flags, canToggle } = frameworkFlags(frames);
  const rows: StackRow[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    if (!flags[index]) {
      rows.push(frameRow(frames[index], index, "frame"));
    } else if (showAll) {
      rows.push(frameRow(frames[index], index, "framework"));
    } else {
      let end = index;
      while (flags[end + 1]) end += 1;
      const run = frames.slice(index, end + 1);
      const packages = [...new Set(run.map(packageName).filter((name): name is string => name !== null))];
      rows.push({ kind: "collapsed", index, label: collapsedLabel(run.length, packages) });
      index = end;
    }
  }
  const first = rows.find((row): row is FrameRow => row.kind === "frame" && row.context !== null);
  if (first) first.open = true;
  return { rows, canToggle };
}

/**
 * "onConfirm · src/pages/booking/ConfirmSlot.tsx:142", the line under the issue title: where the error was
 * raised in the app's own code, the first in app frame from the crash. When every frame is framework the first
 * frame stands in (same rule as the switch above). Null without a string filename, since a function name alone
 * does not say where to look. The line is dropped, not guessed, when it is not a positive integer.
 */
export function crashLocation(frames: Frame[]): string | null {
  const { flags } = frameworkFlags(frames);
  const frame = frames.find((_, index) => !flags[index]);
  if (!frame || typeof frame.filename !== "string" || frame.filename === "") return null;
  const name = typeof frame.function === "string" && frame.function !== "" ? `${clip(frame.function, MAX_HEADER_TEXT_LENGTH)} · ` : "";
  const line = typeof frame.lineno === "number" && Number.isSafeInteger(frame.lineno) && frame.lineno >= 1 ? `:${frame.lineno}` : "";
  return `${name}${clip(frame.filename, MAX_HEADER_TEXT_LENGTH)}${line}`;
}
