import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyLine } from "./ingest-status.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("the verify line says when the last event arrived and how many source maps its release has", () => {
  assert.equal(
    verifyLine({ lastEventAt: ago(2 * 60_000), latestRelease: "2026.11.12-1", sourceMapFiles: 14 }, NOW),
    "Last event received 2m ago · 14 source map files for release 2026.11.12-1",
  );
  assert.equal(
    verifyLine({ lastEventAt: ago(5 * 3_600_000), latestRelease: "r1", sourceMapFiles: 1 }, NOW),
    "Last event received 5h ago · 1 source map file for release r1",
  );
  assert.equal(
    verifyLine({ lastEventAt: ago(1000), latestRelease: "r1", sourceMapFiles: 1234 }, NOW),
    `Last event received just now · ${new Intl.NumberFormat().format(1234)} source map files for release r1`,
  );
});

// Events arriving with no maps for their release is the case the step exists to surface.
test("zero source map files for a real release is said plainly, never as '0 files'", () => {
  assert.equal(
    verifyLine({ lastEventAt: ago(60_000), latestRelease: "2026.11.10-2", sourceMapFiles: 0 }, NOW),
    "Last event received 1m ago · no source map files for release 2026.11.10-2",
  );
});

test("an event with no release says why no maps can match, and never prints 'release null'", () => {
  const line = verifyLine({ lastEventAt: ago(60_000), latestRelease: null, sourceMapFiles: 0 }, NOW);
  assert.equal(line, "Last event received 1m ago · that event has no release, so source maps cannot be matched to it");
  assert.ok(!line.includes("null"));
});

test("no event yet, or an unreadable time, reads as no event received", () => {
  assert.equal(verifyLine({ lastEventAt: null, latestRelease: null, sourceMapFiles: 0 }, NOW), "No event received yet.");
  assert.equal(verifyLine({ lastEventAt: "not a date", latestRelease: "r", sourceMapFiles: 3 }, NOW), "No event received yet.");
  assert.equal(verifyLine({ lastEventAt: "", latestRelease: "r", sourceMapFiles: 3 }, NOW), "No event received yet.");
});

test("both time shapes on the wire read the same instant", () => {
  const zoned = verifyLine({ lastEventAt: "2026-11-12T10:00:00.000Z", latestRelease: "r", sourceMapFiles: 2 }, NOW);
  const zoneless = verifyLine({ lastEventAt: "2026-11-12 10:00:00.000", latestRelease: "r", sourceMapFiles: 2 }, NOW);
  assert.equal(zoned, zoneless);
  assert.ok(zoned.startsWith("Last event received 2h ago"));
});
