import { describe, expect, test } from "bun:test";
import {
  MAX_ANNOTATED_FRAMES,
  classifyExceptionFrames,
  classifyFrame,
  classifyStacktraceFrames,
  contextAround,
  firstAnnotatedFrame,
  replaceSourceContext,
} from "./stack-frames";

describe("classifyFrame: a frame under node_modules is framework code, anything else is left exactly as sent", () => {
  // The browser SDK sets in_app: true on every frame, so the only evidence that can be added is the path.
  const framework = (filename: string, pkg: string, sdkFlag?: boolean) => ({ filename, sdkFlag, pkg });
  const demoted = [
    framework("../../../node_modules/@redux-saga/core/dist/redux-saga-core.esm.js", "@redux-saga/core", true),
    framework("node_modules/react-dom/cjs/react-dom.production.js", "react-dom"),
    framework("node_modules/.pnpm/react@18.3.1/node_modules/react/index.js", "react", true),
    framework("webpack:///./node_modules/scheduler/cjs/x.js", "scheduler", true),
    framework("..\\node_modules\\lodash\\x.js", "lodash", true),
    framework("..\\node_modules\\@scope\\pkg\\x.js", "@scope/pkg", true),
    framework("node_modules/@scope", "@scope", true),
  ];
  for (const { filename, sdkFlag, pkg } of demoted) {
    test(`${filename} -> in_app false, package ${pkg}`, () => {
      const frame: Record<string, unknown> = { filename, function: "f", lineno: 1, ...(sdkFlag === undefined ? {} : { in_app: sdkFlag }) };
      expect(classifyFrame(frame)).toEqual({ ...frame, in_app: false, package: pkg });
    });
  }

  const untouched: Array<[string, Record<string, unknown>]> = [
    ["an app file", { filename: "../../../src/app/util_functions.js", in_app: true }],
    ["a bundle URL", { filename: "https://teacher.myyogateacher.com/assets/index-B3NerMcJ.js", in_app: true }],
    ["a node: internal path the SDK already flagged", { filename: "node:internal/process/task_queues", in_app: false }],
    ["<anonymous>", { filename: "<anonymous>", in_app: true }],
    ["a directory that only contains the words", { filename: "src/my_node_modules_helper/x.js", in_app: true }],
    ["node_modules as a file suffix", { filename: "src/other_node_modules/x.js" }],
    ["a numeric filename", { filename: 123 }],
    ["no filename", { function: "f" }],
  ];
  for (const [name, frame] of untouched) {
    test(`${name} is returned as the same object`, () => {
      expect(classifyFrame(frame)).toBe(frame);
    });
  }

  test("a frame that is not an object comes back as it is, and never throws", () => {
    for (const value of [null, undefined, 5, "x", true, [], [null]]) {
      expect(classifyFrame(value)).toBe(value);
    }
  });

  test("a 100k character filename is cut before matching: bounded work, and a node_modules segment past the cut is not seen", () => {
    const hostile = `${"/".repeat(100_000)}node_modules/${"@".repeat(100_000)}`;
    const startedAt = performance.now();
    const result = classifyFrame({ filename: hostile });
    const elapsed = performance.now() - startedAt;

    expect(result).toEqual({ filename: hostile });
    expect(elapsed).toBeLessThan(50);
  });

  test("a hostile scoped run inside the cut costs a bounded scan", () => {
    const hostile = `node_modules/@${"a".repeat(5000)}`;
    const startedAt = performance.now();
    const result = classifyFrame({ filename: hostile }) as unknown as { package: string };

    expect(result.package.length).toBeLessThanOrEqual(2048);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});

describe("contextAround", () => {
  const file = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

  test("middle of the file gives 3 lines before, the line, 3 after", () => {
    expect(contextAround(file, 5)).toEqual({
      pre_context: ["line 2", "line 3", "line 4"],
      context_line: "line 5",
      post_context: ["line 6", "line 7", "line 8"],
    });
  });

  test("line 1 has nothing before", () => {
    expect(contextAround(file, 1)).toEqual({ pre_context: [], context_line: "line 1", post_context: ["line 2", "line 3", "line 4"] });
  });

  test("line 2 has one line before: the count is 1, not padded to 3", () => {
    expect(contextAround(file, 2)?.pre_context).toEqual(["line 1"]);
  });

  test("the last line has nothing after", () => {
    expect(contextAround(file, 10)).toEqual({ pre_context: ["line 7", "line 8", "line 9"], context_line: "line 10", post_context: [] });
  });

  test("a line that does not exist gives null: 0, past the end, negative, fractional, NaN", () => {
    for (const line of [0, 11, 1000, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextAround(file, line)).toBeNull();
    }
  });

  test("a trailing newline ends the last line, it does not add an empty line", () => {
    expect(contextAround("a\nb\n", 2)).toEqual({ pre_context: ["a"], context_line: "b", post_context: [] });
    expect(contextAround("a\nb\n", 3)).toBeNull();
    expect(contextAround("a\n\n", 2)).toEqual({ pre_context: ["a"], context_line: "", post_context: [] });
  });

  test("CRLF and LF both split lines, and the carriage return is not left on the line", () => {
    expect(contextAround("a\r\nb\r\nc", 2)).toEqual({ pre_context: ["a"], context_line: "b", post_context: ["c"] });
  });

  test("empty content has no line 1", () => {
    expect(contextAround("", 1)).toBeNull();
  });

  test("a 1000 character line comes back at 300, before, at and after the crash line", () => {
    const long = "x".repeat(1000);
    const context = contextAround(`${long}\n${long}\n${long}`, 2)!;

    expect(context.pre_context[0]).toHaveLength(300);
    expect(context.context_line).toHaveLength(300);
    expect(context.post_context[0]).toHaveLength(300);
  });
});

describe("replaceSourceContext", () => {
  const sdkLines = { pre_context: ["minified before"], context_line: "minified line", post_context: ["minified after"] };

  test("replaces the SDK's lines with the source's, keeping every other field", () => {
    const frame = { filename: "src/a.ts", lineno: 2, function: "f", ...sdkLines };

    expect(replaceSourceContext(frame, "a\nb\nc", 2)).toEqual({
      filename: "src/a.ts",
      lineno: 2,
      function: "f",
      pre_context: ["a"],
      context_line: "b",
      post_context: ["c"],
    });
  });

  test("without source text the SDK's lines are dropped: they describe the minified file", () => {
    expect(replaceSourceContext({ filename: "src/a.ts", lineno: 2, ...sdkLines }, null, 2)).toEqual({ filename: "src/a.ts", lineno: 2 });
  });

  test("source text that is not a string, as a malformed map can hold, leaves a header only frame instead of throwing", () => {
    for (const content of [5, {}, [], true, undefined]) {
      expect(replaceSourceContext({ filename: "x", ...sdkLines }, content, 2)).toEqual({ filename: "x" });
    }
  });

  test("a line that is not in the text, or not a number, leaves a header only frame", () => {
    expect(replaceSourceContext({ filename: "x", ...sdkLines }, "a\nb", 9)).toEqual({ filename: "x" });
    expect(replaceSourceContext({ filename: "x", ...sdkLines }, "a\nb", "2")).toEqual({ filename: "x" });
    expect(replaceSourceContext({ filename: "x", ...sdkLines }, "a\nb", undefined)).toEqual({ filename: "x" });
  });
});

describe("classifyStacktraceFrames and classifyExceptionFrames", () => {
  const app = { filename: "src/app.ts", lineno: 1 };
  const lib = { filename: "node_modules/react-dom/x.js", lineno: 2 };

  test("only the last MAX_ANNOTATED_FRAMES frames are classified: the work is bounded for a hostile frame count", () => {
    const frames = Array.from({ length: MAX_ANNOTATED_FRAMES + 10 }, () => ({ ...lib }));
    const result = classifyStacktraceFrames({ frames }).frames as Array<Record<string, unknown>>;

    expect(result).toHaveLength(MAX_ANNOTATED_FRAMES + 10);
    expect(result.slice(0, 10).every((frame) => frame.in_app === undefined)).toBe(true);
    expect(result.slice(10).every((frame) => frame.in_app === false && frame.package === "react-dom")).toBe(true);
    expect(firstAnnotatedFrame(7)).toBe(0);
    expect(firstAnnotatedFrame(MAX_ANNOTATED_FRAMES + 10)).toBe(10);
  });

  test("keeps the other stacktrace fields and an app frame as the same object", () => {
    const result = classifyStacktraceFrames({ frames: [app, lib], registers: { a: 1 } });

    expect(result.registers).toEqual({ a: 1 });
    expect((result.frames as unknown[])[0]).toBe(app);
    expect((result.frames as unknown[])[1]).toEqual({ ...lib, in_app: false, package: "react-dom" });
  });

  test("a stacktrace that is not an object with a frames array comes back as it is", () => {
    for (const value of [null, undefined, "x", 5, [], {}, { frames: "x" }, { frames: null }]) {
      expect(classifyStacktraceFrames(value)).toBe(value);
    }
  });

  test("frames that are null, numbers or strings pass through next to real ones without throwing", () => {
    const result = classifyStacktraceFrames({ frames: [null, 5, "x", lib] }).frames as unknown[];

    expect(result.slice(0, 3)).toEqual([null, 5, "x"]);
    expect(result[3]).toEqual({ ...lib, in_app: false, package: "react-dom" });
  });

  test("exception values: each stacktrace is classified, and a null or stacktrace-less value is left alone", () => {
    const exception = { values: [{ type: "E", stacktrace: { frames: [lib] } }, null, 5, { type: "NoStack" }, { type: "NullStack", stacktrace: null }] };
    const result = classifyExceptionFrames(exception) as { values: unknown[] };

    expect(result.values[0]).toEqual({ type: "E", stacktrace: { frames: [{ ...lib, in_app: false, package: "react-dom" }] } });
    expect(result.values.slice(1)).toEqual([null, 5, { type: "NoStack" }, { type: "NullStack", stacktrace: null }]);
    expect(Object.keys(result.values[3] as object)).toEqual(["type"]);
  });

  test("an exception that is not an object with a values array comes back as the same value", () => {
    const exception = { type: "E", value: "v" };

    expect(classifyExceptionFrames(exception)).toBe(exception);
    for (const value of [null, undefined, "x", 5, [], { values: "x" }, { values: null }]) {
      expect(classifyExceptionFrames(value)).toBe(value);
    }
  });
});
