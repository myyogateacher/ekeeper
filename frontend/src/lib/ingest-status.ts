import type { IngestStatus } from "@ekeeper/shared";
import { pluralize } from "./plural.ts";
import { formatRelative, parseServerTime } from "./time.ts";
import { formatNumber } from "./utils.ts";

/**
 * The Connect an app "Verify" line from the project's ingest status:
 * "Last event received 2m ago · 14 source map files for release 2026.11.12-1".
 *
 * `latestRelease` is the release of the project's newest event, and `sourceMapFiles` counts the maps uploaded
 * for exactly that release (shared/src/contracts.ts IngestStatus), so the two halves describe the same event
 * and cannot disagree. Source maps are matched to an event by its release, so an event without one cannot be
 * mapped, and the line says that instead of "0 files for release null". Zero files for a real release is
 * stated plainly: it is the case this step exists to surface (events arriving, maps missing).
 */
export function verifyLine(status: IngestStatus, now: number): string {
  if (!parseServerTime(status.lastEventAt)) return "No event received yet.";
  const received = `Last event received ${formatRelative(status.lastEventAt, now)}`;
  if (!status.latestRelease) return `${received} · that event has no release, so source maps cannot be matched to it`;
  const files = status.sourceMapFiles === 0 ? "no source map files" : `${formatNumber(status.sourceMapFiles)} source map ${pluralize(status.sourceMapFiles, "file")}`;
  return `${received} · ${files} for release ${status.latestRelease}`;
}
