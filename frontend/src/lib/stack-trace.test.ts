import { test } from "node:test";
import assert from "node:assert/strict";
import { collapsedLabel, crashLocation, frameContext, stackView, type FrameRow } from "./stack-trace.ts";
import type { Frame } from "./issue-detail.ts";

// What a frame carries after the backend annotated it (backend/src/lib/stack-frames.ts): the crash line plus up
// to three lines each side, line numbers counted from `lineno`.
const withSource: Frame = {
  function: "onConfirm",
  filename: "src/pages/ConfirmSlot.tsx",
  lineno: 142,
  colno: 38,
  pre_context: ["const a = 1;", "", "async function onConfirm() {"],
  context_line: "  const id = slot.session.session_id;",
  post_context: ["  await book(id);", "  navigate('/done');", "}"],
};

test("source lines are numbered from the frame's line, with the crash line marked", () => {
  const lines = frameContext(withSource)!;
  assert.deepEqual(lines.map((line) => line.number), [139, 140, 141, 142, 143, 144, 145]);
  assert.deepEqual(lines.map((line) => line.crash), [false, false, false, true, false, false, false]);
  assert.equal(lines[3].text, "  const id = slot.session.session_id;");
  assert.equal(lines[1].text, "", "a blank source line is kept: dropping it would shift the numbers");
});

test("fewer lines than the window, line 1 and a crash line alone all number correctly", () => {
  assert.deepEqual(frameContext({ lineno: 1, context_line: "x", post_context: ["y"] })!.map((line) => line.number), [1, 2]);
  assert.deepEqual(frameContext({ lineno: 10, context_line: "x", pre_context: ["a"] })!.map((line) => line.number), [9, 10]);
  assert.deepEqual(frameContext({ lineno: 10, context_line: "x" })!.map((line) => line.number), [10]);
  // Three before-lines cannot sit above line 2; only the one nearest the crash does.
  assert.deepEqual(frameContext({ lineno: 2, context_line: "x", pre_context: ["a", "b", "c"] })!.map((line) => `${line.number}:${line.text}`), ["1:c", "2:x"]);
});

// A frame is whatever a DSN holder wrote. Each case is a field of the wrong shape; none may throw, and the lines
// that cannot be trusted are dropped rather than printed with a wrong number.
test("hostile frame shapes read as no source or as the crash line alone, and never throw", () => {
  const frame = (over: Frame): Frame => ({ lineno: 12, context_line: "crash", ...over });
  assert.equal(frameContext({}), null);
  assert.equal(frameContext({ lineno: 12 }), null, "no context_line");
  assert.equal(frameContext({ context_line: "x" }), null, "no lineno");
  for (const lineno of ["12", 0, -3, 1.5, NaN, Infinity, 2 ** 60, null, {}, [12], true]) {
    assert.equal(frameContext(frame({ lineno })), null, `lineno ${String(lineno)}`);
  }
  for (const context_line of [5, null, ["x"], {}, undefined]) {
    assert.equal(frameContext(frame({ context_line })), null, `context_line ${JSON.stringify(context_line)}`);
  }
  for (const side of ["pre_context", "post_context"] as const) {
    for (const bad of ["x", [null], [1, 2], ["ok", null, "ok"], {}, 5, null, [["nested"]]]) {
      assert.deepEqual(frameContext(frame({ [side]: bad }))!.map((line) => line.number), [12], `${side} ${JSON.stringify(bad)}`);
    }
  }
});

test("one frame cannot add more than 3 lines a side or draw a line over 300 characters", () => {
  const many = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`);
  const lines = frameContext({ lineno: 3000, context_line: "x".repeat(1_000_000), pre_context: many.slice(0, 2999), post_context: many.slice(3000) })!;
  assert.deepEqual(lines.map((line) => line.number), [2997, 2998, 2999, 3000, 3001, 3002, 3003]);
  assert.equal(lines[0].text, "line 2997", "the lines kept are the ones nearest the crash");
  assert.equal(lines[3].text.length, 300);
});

test("the crash line is reported by its own number and a non-string package or flag changes nothing about it", () => {
  assert.equal(frameContext({ lineno: 7, context_line: "x", package: 5, in_app: "false" })!.find((line) => line.crash)!.number, 7);
});

const app = (name: string, extra: Frame = {}): Frame => ({ function: name, filename: `src/${name}.ts`, lineno: 10, in_app: true, ...extra });
const lib = (name: string, pkg?: string): Frame => ({ function: name, filename: `node_modules/${pkg ?? "x"}/${name}.js`, lineno: 1, in_app: false, ...(pkg ? { package: pkg } : {}) });
const kinds = (rows: ReturnType<typeof stackView>["rows"]) => rows.map((row) => `${row.kind}:${row.index}`);

// Canvas IssueDetail: crash frame, four react-dom/scheduler frames, then two app frames.
const canvasStack: Frame[] = [
  app("onConfirm", withSource),
  lib("callCallback", "react-dom"),
  lib("invokeGuardedCallbackImpl", "react-dom"),
  lib("dispatchDiscreteEvent", "react-dom"),
  lib("performWorkUntilDeadline", "scheduler"),
  app("handleSubmit"),
  app("ConfirmSlot"),
];

test("In app view folds each run of framework frames into one row where the run sits", () => {
  const view = stackView(canvasStack, false);
  assert.equal(view.canToggle, true);
  assert.deepEqual(kinds(view.rows), ["frame:0", "collapsed:1", "frame:5", "frame:6"]);
  assert.equal(view.rows[1].kind === "collapsed" && view.rows[1].label, "Show 4 framework frames (react-dom, scheduler)");
});

test("All frames view draws every framework frame as its own muted row with no source lines", () => {
  const view = stackView([...canvasStack.slice(0, 2), { ...lib("x", "y"), context_line: "code", lineno: 3 }, ...canvasStack.slice(5)], true);
  assert.deepEqual(kinds(view.rows), ["frame:0", "framework:1", "framework:2", "frame:3", "frame:4"]);
  assert.equal((view.rows[2] as FrameRow).context, null);
});

test("two separate framework runs stay two rows, each counting only its own frames", () => {
  const view = stackView([app("a"), lib("l1", "react"), lib("l2", "react"), app("b"), lib("l3", "lodash"), app("c")], false);
  assert.deepEqual(view.rows.map((row) => row.kind === "collapsed" ? row.label : row.kind), [
    "frame",
    "Show 2 framework frames (react)",
    "frame",
    "Show 1 framework frame (lodash)",
    "frame",
  ]);
});

test("the switch exists only with both kinds of frame; all in app or all framework shows every frame", () => {
  const onlyApp = stackView([app("a"), app("b")], false);
  assert.equal(onlyApp.canToggle, false);
  assert.deepEqual(kinds(onlyApp.rows), ["frame:0", "frame:1"]);
  for (const showAll of [false, true]) {
    const onlyLib = stackView([lib("a", "p"), lib("b", "p")], showAll);
    assert.equal(onlyLib.canToggle, false);
    assert.deepEqual(kinds(onlyLib.rows), ["frame:0", "frame:1"], "never an empty card, never muted when it is all there is");
  }
  assert.deepEqual(stackView([], false), { rows: [], canToggle: false });
});

test("only the first frame with source lines is open, and a framework row never takes it", () => {
  const open = (frames: Frame[], showAll = false) => stackView(frames, showAll).rows.map((row) => row.kind !== "collapsed" && row.open);
  const second = { ...withSource, function: "second" };
  assert.deepEqual(open([app("a"), app("b", withSource), app("c", second)]), [false, true, false]);
  assert.deepEqual(open([app("a"), app("b")]), [false, false], "nothing to open");
  assert.deepEqual(open([lib("l", "p"), app("b", withSource), app("c", second)], true), [false, true, false]);
  assert.deepEqual(open([{ ...lib("l", "p"), ...withSource }, app("b", second)], true), [false, true], "the framework frame's own lines are not drawn, so it is not the open one");
});

// in_app is read as the backend wrote it: only a boolean false is framework. Anything else is junk from a DSN
// holder and must not hide a frame.
test("only a boolean in_app false is framework; junk flags and packages never hide or break a frame", () => {
  const junk = (in_app: unknown): Frame => ({ function: "f", filename: "a.js", in_app });
  for (const flag of ["false", 0, null, "", {}, [], undefined, 1]) {
    assert.deepEqual(kinds(stackView([junk(flag), lib("l", "p"), app("b")], false).rows), ["frame:0", "collapsed:1", "frame:2"], JSON.stringify(flag));
  }
  const labelFor = (pkg: unknown) => stackView([app("a"), { function: "l", in_app: false, package: pkg }], false).rows[1];
  for (const pkg of [5, null, {}, [], "", undefined]) {
    assert.equal((labelFor(pkg) as { label: string }).label, "Show 1 framework frame", `package ${JSON.stringify(pkg)}`);
  }
});

test("a frame with hostile text fields still gets a header row", () => {
  const rows = stackView([{ function: { toString: 1 }, filename: ["a", 1], lineno: { x: 1 }, colno: null, deobfuscated: "yes" }], false).rows as FrameRow[];
  assert.equal(rows[0].fn, '{"toString":1}');
  assert.equal(rows[0].location, '["a",1]:{"x":1}', "a null column leaves no dangling colon");
  assert.equal(rows[0].mapped, false, "only a boolean true counts as mapped");
  const long = stackView([{ function: "f".repeat(100_000), filename: "g".repeat(100_000) }], false).rows[0] as FrameRow;
  assert.equal(long.fn.length, 2048);
  assert.ok(long.location.length <= 2048);
  const bare = stackView([{}], false).rows[0] as FrameRow;
  assert.deepEqual([bare.fn, bare.location, bare.mapped, bare.context], ["?", "unknown file", false, null]);
});

test("the collapsed row names up to four packages once each, then counts the rest", () => {
  assert.equal(collapsedLabel(4, ["react-dom", "scheduler"]), "Show 4 framework frames (react-dom, scheduler)");
  assert.equal(collapsedLabel(1, ["react-dom"]), "Show 1 framework frame (react-dom)");
  assert.equal(collapsedLabel(3, []), "Show 3 framework frames");
  assert.equal(collapsedLabel(9, ["a", "b", "c", "d", "e", "f"]), "Show 9 framework frames (a, b, c, d, +2 more)");
  const view = stackView([app("a"), lib("1", "react"), lib("2", "react"), lib("3", "@redux-saga/core")], false);
  assert.equal((view.rows[1] as { label: string }).label, "Show 3 framework frames (react, @redux-saga/core)");
});

test("stacking the same input twice gives the same rows, so nothing leaks between renders", () => {
  assert.deepEqual(stackView(canvasStack, false), stackView(canvasStack, false));
  assert.deepEqual(stackView(canvasStack, true), stackView(canvasStack, true));
});

test("the crash line is the first in app frame as 'function · file:line'", () => {
  assert.equal(crashLocation(canvasStack), "onConfirm · src/pages/ConfirmSlot.tsx:142");
  assert.equal(crashLocation([lib("l", "p"), app("b")]), "b · src/b.ts:10", "a framework crash frame is skipped");
  assert.equal(crashLocation([lib("l", "p"), lib("m", "p")]), "l · node_modules/p/l.js:1", "all framework: the crash frame stands in");
  assert.equal(crashLocation([]), null);
});

test("the crash line drops what cannot be read instead of printing it", () => {
  assert.equal(crashLocation([{ filename: "a.js", lineno: 3 }]), "a.js:3", "no function name");
  assert.equal(crashLocation([{ function: "f", filename: "a.js" }]), "f · a.js", "no line");
  for (const lineno of ["12", 0, -1, 1.5, NaN, null, {}]) {
    assert.equal(crashLocation([{ function: "f", filename: "a.js", lineno }]), "f · a.js", `lineno ${String(lineno)}`);
  }
  for (const filename of [undefined, "", 5, null, {}, ["a.js"]]) {
    assert.equal(crashLocation([{ function: "f", filename, lineno: 3 }]), null, `filename ${JSON.stringify(filename)}`);
  }
  for (const fn of [5, "", null, {}]) {
    assert.equal(crashLocation([{ function: fn, filename: "a.js", lineno: 3 }]), "a.js:3", `function ${JSON.stringify(fn)}`);
  }
});
