import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { SourceMapGenerator } from "source-map-js";
import { config } from "../config";
import { run } from "../db/sqlite";
import { deobfuscateEvent, saveMinimapArtifact } from "./minimaps";

// Source lines cost real work on the single event loop, and the event is chosen by anyone holding the public DSN:
// ingest stores `exception.values` as sent, and every read of the event (the issue page, MCP get_event, the ingest
// flush creating a GitHub issue) goes through deobfuscateEvent. A bound per stack is no bound per event, because
// the number of stacks is unbounded (PROD-10537 security review M1: 400 values of 50 frames over a 1 MB source
// took 5.5 s). These tests need SQLite and the minimap folder but no ClickHouse.

const suffix = Math.random().toString(36).slice(2, 8);
const projectId = `p_budget_${suffix}`;
const release = `rel_big_${suffix}`;
const now = new Date().toISOString();
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [projectId, `Budget ${suffix}`, `budget-${suffix}`, "production", 1, now, now]);

// One 1 MB source (20,000 lines of 50 characters) and 50 generated positions that all land near its end, the worst
// case for reading source lines: every frame is mapped and every line is far into the text.
const generator = new SourceMapGenerator({ file: "big.js" });
for (let index = 0; index < 50; index += 1) {
  generator.addMapping({ generated: { line: index + 1, column: 0 }, source: "src/big.ts", original: { line: 19_950 + index, column: 0 } });
}
generator.setSourceContent("src/big.ts", Array.from({ length: 20_000 }, (_, index) => `${String(index + 1).padStart(5, "0")} ${"x".repeat(44)}`).join("\n"));
const artifact = saveMinimapArtifact({
  org: config.EKEEPER_ORG,
  projectId,
  project: `budget-${suffix}`,
  release,
  artifactName: "~/web-zoom/assets/big.js.map",
  buffer: Buffer.from(generator.toString()),
});
afterAll(() => {
  if (existsSync(artifact.filePath)) rmSync(artifact.filePath, { force: true });
  run(`DELETE FROM minimap_artifacts WHERE project_id = ?`, [projectId]);
  run(`DELETE FROM projects WHERE id = ?`, [projectId]);
});

type Frame = Record<string, unknown>;
const stackOf = (count: number): { frames: Frame[] } => ({
  frames: Array.from({ length: count }, (_, index) => ({ filename: "https://myyogateacher.com/web-zoom/assets/big.js", lineno: (index % 50) + 1, colno: 1 })),
});
const event = (input: { stacktrace: { frames: Frame[] } | null; values: Array<{ stacktrace: { frames: Frame[] } } | null> }) =>
  deobfuscateEvent({ projectId, rawPayload: JSON.stringify({ release }), stacktrace: input.stacktrace, exception: { values: input.values } });
const framesOf = (stack: unknown) => ((stack as { frames: Frame[] } | null)?.frames ?? []);
const annotated = (frames: Frame[]) => frames.filter((frame) => typeof frame.context_line === "string").length;
const totalAnnotated = (result: ReturnType<typeof deobfuscateEvent>) =>
  annotated(framesOf(result.stacktrace)) +
  ((result.exception.values as Array<{ stacktrace?: unknown } | null>) ?? []).reduce((sum, value) => sum + annotated(framesOf(value?.stacktrace)), 0);

// A number chosen up front, not a measurement. The security review measured 5,537 ms for this event before the
// budget; one stack of 50 frames takes about 45 ms here, so 250 ms leaves room for a slow machine and still fails
// by an order of magnitude if the per event bound goes.
const BUDGET_MS = 250;

describe("source lines: one budget per event", () => {
  test(`400 exception values of 50 frames over one 1 MB source annotate at most 50 frames in all, in under ${BUDGET_MS} ms`, () => {
    const stack = stackOf(50);
    const values = Array.from({ length: 400 }, () => ({ stacktrace: stackOf(50) }));

    const startedAt = performance.now();
    const result = event({ stacktrace: stack, values });
    const elapsed = performance.now() - startedAt;
    console.log(`[source budget] 400 values x 50 frames plus the top level stack: ${elapsed.toFixed(1)} ms, ${totalAnnotated(result)} frames with source lines`);

    expect(totalAnnotated(result)).toBeLessThanOrEqual(50);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    // Every frame is still mapped; only the source lines are budgeted.
    for (const value of result.exception.values as Array<{ stacktrace: { frames: Frame[] } }>) {
      expect(value.stacktrace.frames.every((frame) => frame.deobfuscated === true)).toBe(true);
    }
  });

  test("the budget is spent on the top level stack first, from its crash end, so the stack the page shows has its lines", () => {
    const result = event({ stacktrace: stackOf(50), values: [{ stacktrace: stackOf(50) }, { stacktrace: stackOf(50) }] });

    expect(annotated(framesOf(result.stacktrace))).toBe(50);
    expect(totalAnnotated(result)).toBe(50);
  });

  test("a stack longer than the budget gets its lines on the frames nearest the crash, the end of the list", () => {
    const result = event({ stacktrace: stackOf(120), values: [] });
    const frames = framesOf(result.stacktrace);

    expect(frames.slice(0, 70).some((frame) => "context_line" in frame)).toBe(false);
    expect(frames.slice(70).every((frame) => typeof frame.context_line === "string")).toBe(true);
  });

  test("with no top level stack, the primary exception is values[0] and takes the budget before values[1]", () => {
    const result = event({ stacktrace: null, values: [{ stacktrace: stackOf(30) }, { stacktrace: stackOf(30) }, { stacktrace: stackOf(30) }] });
    const [first, second, third] = result.exception.values as Array<{ stacktrace: { frames: Frame[] } }>;

    expect(annotated(first!.stacktrace.frames)).toBe(30);
    expect(annotated(second!.stacktrace.frames)).toBe(20);
    expect(annotated(third!.stacktrace.frames)).toBe(0);
  });

  test("a frame the budget leaves without lines never keeps the SDK's own minified lines", () => {
    const sdkLines = { pre_context: ["minified"], context_line: "minified", post_context: ["minified"] };
    const stack = { frames: stackOf(60).frames.map((frame) => ({ ...frame, ...sdkLines })) };

    const frames = framesOf(event({ stacktrace: stack, values: [] }).stacktrace);

    expect(frames.every((frame) => frame.context_line !== "minified")).toBe(true);
  });

  test("50 frames in one stack still take under the budget, each with the lines around its original line", () => {
    const startedAt = performance.now();
    const result = event({ stacktrace: stackOf(50), values: [{ stacktrace: stackOf(50) }] });
    const elapsed = performance.now() - startedAt;
    const crash = framesOf(result.stacktrace)[49] as { lineno: number; context_line: string; pre_context: string[]; post_context: string[] };

    expect(crash.lineno).toBe(19_999);
    expect(crash.context_line).toMatch(/^19999 /);
    expect(crash.pre_context).toHaveLength(3);
    expect(crash.post_context).toHaveLength(1);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
