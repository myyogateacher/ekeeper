// Pure rules for what the issue page and MCP `get_event` add to a stack frame on read: which frames are
// framework code, and the source lines around the crash. No imports on purpose: minimaps.ts owns the file and
// source map I/O and hands plain values in, so every branch below is tested with a table and nothing here
// touches disk. The frontend reads `in_app === false` and `package` as given and never re-derives the
// node_modules rule (defect register entry 5): the rule lives only in this file.
//
// Every input is untrusted JSON. A frame is whatever the SDK sent and ingest accepts any JSON from a public
// DSN, so each helper checks the shape it reads and returns the input unchanged when it does not match
// (defect register entries 88 and 92: a `null` frame must not throw, because deobfuscateEvent also runs inside
// the ingest flush through issue-sync, and one throw there retries the whole bucket every 5 minutes).

type UnknownRecord = Record<string, unknown>;

// The SDK sends at most this many frames per stack (STACKTRACE_FRAME_LIMIT = 50 in @sentry/core
// utils-hoist/stacktrace.js), so no real event loses anything. Ingest itself accepts any number of frames from
// a public DSN, and this work runs on the single event loop in the request handler, so the node_modules
// classification is bounded to the frames nearest the crash of each stack. Frames come oldest first, so those are
// the last ones. This bound is per stack; the source lines below have a bound per event.
export const MAX_ANNOTATED_FRAMES = 50;

// Source lines cost a lookup in the map and up to seven lines on the wire per frame, and an event can hold any
// number of stacks (ingest stores `exception.values` as sent), so a bound per stack is no bound per event: 400
// values of 50 frames over a 1 MB source took 5.5 s (PROD-10537 security review M1). One stack's worth, the SDK's
// own frame limit, is the budget for the whole event, shared by every stack and spent in the order
// deobfuscateEvent walks them: the top level stacktrace first (the stack the issue page shows), then
// exception.values[0], [1] and so on, each from its crash end, the last frame, backwards.
export const MAX_SOURCE_LINE_FRAMES_PER_EVENT = 50;

// Same length-cap idea as MAX_NORMALIZED_TEXT_LENGTH in ingest.ts: a filename is cut before a regex reads it so
// a crafted one costs a bounded amount of work (defect register entry 79). Real filenames are far shorter.
const MAX_FILENAME_LENGTH = 2048;

// Source text lines are cut so one minified vendor line in a map's sourcesContent cannot put hundreds of KB on
// the wire: 3 + 1 + 3 lines per frame, 50 frames, and both copies of the stack are mapped.
const MAX_CONTEXT_LINE_LENGTH = 300;
const CONTEXT_LINES_EACH_SIDE = 3;

// A `node_modules` path segment followed by the package name, scope kept (`@redux-saga/core`). The segment must
// start the path or follow a separator, so `src/my_node_modules_helper/x.js` is not matched. `\` is accepted
// because a Windows build can emit it in a map's sources. The package name is the LAST match: under pnpm the
// path is `node_modules/.pnpm/react@18.3.1/node_modules/react/index.js`, and the first match is the store
// directory `.pnpm`, not the package. Global so matchAll sees every match; it is read only through matchAll, never
// .test() or .exec(), because those carry `lastIndex` on this shared object into the next frame and the second
// frame with the same filename would miss (stack-frames.test.ts classifies one filename repeatedly).
const NODE_MODULES_PACKAGE = /(?:^|[\\/])node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first frame index that gets annotated for a stack of `length` frames: the last MAX_ANNOTATED_FRAMES.
 */
export function firstAnnotatedFrame(length: number): number {
  return Math.max(0, length - MAX_ANNOTATED_FRAMES);
}

/**
 * Marks a frame as framework code when its filename (after source mapping, when a map applied) has a
 * `node_modules` segment: `in_app: false` and `package` set. Path evidence only demotes. The browser SDK sets
 * `in_app: true` on every frame ("All browser frames are considered in_app" in @sentry/browser
 * stack-parsers.js), so an SDK `false` is honoured by leaving the frame alone, and a bundle URL that is not
 * under node_modules stays in app. Returns the same object when nothing changes.
 */
export function classifyFrame<T>(frame: T): T {
  if (!isRecord(frame) || typeof frame.filename !== "string") {
    return frame;
  }
  let packageName: string | undefined;
  for (const match of frame.filename.slice(0, MAX_FILENAME_LENGTH).matchAll(NODE_MODULES_PACKAGE)) {
    packageName = match[1];
  }
  if (packageName === undefined) {
    return frame;
  }
  return { ...frame, in_app: false, package: packageName.replaceAll("\\", "/") } as T;
}

export interface SourceContext {
  pre_context: string[];
  context_line: string;
  post_context: string[];
}

/**
 * A source file's text as lines, split once so every frame in the event that points into it is a lookup. A
 * trailing newline leaves one empty piece at the end that is the end of the last line, not a line of its own.
 */
export function splitSourceLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Up to 3 lines before, the line itself and up to 3 after. `line` is 1-based, as in a frame's `lineno`. Null when
 * the line does not exist: not a positive integer, or past the end of the text.
 */
export function contextFromLines(lines: readonly string[], line: number): SourceContext | null {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return null;
  }
  const cut = (text: string) => text.slice(0, MAX_CONTEXT_LINE_LENGTH);
  return {
    pre_context: lines.slice(Math.max(0, line - 1 - CONTEXT_LINES_EACH_SIDE), line - 1).map(cut),
    context_line: cut(lines[line - 1]!),
    post_context: lines.slice(line, line + CONTEXT_LINES_EACH_SIDE).map(cut),
  };
}

/**
 * What one deobfuscateEvent call carries from frame to frame: how many frames may still get source lines, and the
 * lines of every source already split, keyed by the caller (artifact and source). A source that many frames point
 * into is split once per call, not once per frame.
 */
export interface SourceLineState {
  remaining: number;
  lines: Map<string, string[] | null>;
}

export function newSourceLineState(): SourceLineState {
  return { remaining: MAX_SOURCE_LINE_FRAMES_PER_EVENT, lines: new Map() };
}

/**
 * Sets the three source line fields on a source mapped frame, or removes them. Whatever lines the SDK sent on
 * this frame described the minified file, and showing them under the original filename and line number would
 * be wrong, so they are always dropped, budget or not; without source text the frame is a header row. `line` is
 * the mapped (original) line number. A frame spends one unit of the event's budget only when it gets lines, so a
 * frame into a source with no text costs nothing, and once the budget is spent `readContent` is never called.
 */
export function replaceSourceContext(
  frame: UnknownRecord,
  state: SourceLineState,
  key: string,
  readContent: () => unknown,
  line: unknown,
): UnknownRecord {
  const { pre_context: _pre, context_line: _line, post_context: _post, ...rest } = frame;
  if (state.remaining <= 0) {
    return rest;
  }
  let lines = state.lines.get(key);
  if (lines === undefined) {
    // `content` is an entry of the uploaded map's sourcesContent, parsed from JSON, so it is a string only when the
    // build wrote one: null for a source without text, and anything at all in a malformed map.
    const content = readContent();
    lines = typeof content === "string" ? splitSourceLines(content) : null;
    state.lines.set(key, lines);
  }
  const context = lines && typeof line === "number" ? contextFromLines(lines, line) : null;
  if (!context) {
    return rest;
  }
  state.remaining -= 1;
  return { ...rest, ...context };
}

/**
 * classifyFrame over the last MAX_ANNOTATED_FRAMES frames of a stacktrace object. Anything that is not an
 * object with a `frames` array comes back as it is, so the caller can pass a stored value straight in.
 */
export function classifyStacktraceFrames<T>(stacktrace: T): T {
  if (!isRecord(stacktrace) || !Array.isArray(stacktrace.frames)) {
    return stacktrace;
  }
  const frames: unknown[] = stacktrace.frames;
  const start = firstAnnotatedFrame(frames.length);
  return { ...stacktrace, frames: frames.map((frame, index) => (index < start ? frame : classifyFrame(frame))) } as T;
}

/**
 * classifyStacktraceFrames over each `exception.values[].stacktrace`. A `values` entry that is not an object,
 * or has no stacktrace, is left as it is, and so is an exception that is not an object with a `values` array.
 */
export function classifyExceptionFrames<T>(exception: T): T {
  if (!isRecord(exception) || !Array.isArray(exception.values)) {
    return exception;
  }
  return {
    ...exception,
    values: exception.values.map((value) =>
      isRecord(value) && "stacktrace" in value ? { ...value, stacktrace: classifyStacktraceFrames(value.stacktrace) } : value,
    ),
  } as T;
}
