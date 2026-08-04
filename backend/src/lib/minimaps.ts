import type { SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SourceMapConsumer, type RawSourceMap } from "source-map-js";
import { config } from "../config";
import { all, one, run } from "../db/sqlite";
import { HttpError } from "./http";
import { createId } from "./ids";
import type { MinimapArtifact } from "@ekeeper/shared";

type UnknownRecord = Record<string, unknown>;

interface SourceMapLookupArtifact extends MinimapArtifact {}

interface ParsedSourceMapArtifact {
  artifact: SourceMapLookupArtifact;
  rawMap: RawSourceMap & {
    file?: string;
    debug_id?: string;
    debugId?: string;
  };
}

interface DeobfuscationResult {
  stacktrace: UnknownRecord | null;
  exception: UnknownRecord;
  applied: boolean;
  release: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const CLEANUP_BATCH_SIZE = 25;
const SCHEDULED_CLEANUP_DELAY_MS = 60 * 1000;
const SCHEDULED_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Orphan files younger than this are left alone: their row may still be in flight.
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

// Ranks each project's releases by recency, where release recency is the newest
// upload inside that release. When a projectId is given only that project's releases
// are ranked, and the CTE takes one leading binding: the project id.
// Must sit at the top of the statement using it.
function rankedReleasesCte(projectId?: string) {
  return `
  ranked_releases AS (
    SELECT project_id, release,
      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY MAX(uploaded_at) DESC) AS release_rank
    FROM minimap_artifacts
    ${projectId ? "WHERE project_id = ?" : ""}
    GROUP BY project_id, release
  )
`;
}

// Age-based half of the retention policy, optionally scoped to a project.
// Takes the retention cutoff, then the project id when one is given.
function ageExpiredWhere(projectId?: string) {
  return `WHERE uploaded_at < ?${projectId ? " AND project_id = ?" : ""}`;
}

// Artifacts whose (project_id, release) falls outside the N most recent releases.
// Takes one binding: the number of releases to keep.
function overReleaseLimitSelect(columns: string) {
  return `
    SELECT ${columns}
    FROM minimap_artifacts a
    JOIN ranked_releases r ON r.project_id = a.project_id AND r.release = a.release
    WHERE r.release_rank > ?
  `;
}

let cleanupRunning = false;

const storageRoot = path.isAbsolute(config.MINIMAPS_STORAGE_PATH)
  ? config.MINIMAPS_STORAGE_PATH
  : path.resolve(import.meta.dir, "../../..", config.MINIMAPS_STORAGE_PATH);

function ensureStorageRoot() {
  mkdirSync(storageRoot, { recursive: true });
}

function retentionMs() {
  return config.MINIMAPS_RETENTION_DAYS * DAY_MS;
}

function retentionCutoff() {
  return new Date(Date.now() - retentionMs()).toISOString();
}

function keepReleases() {
  return config.MINIMAPS_KEEP_RELEASES;
}

function clampLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

function clampOffset(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function normalizeRelease(value: string) {
  return value.trim();
}

function normalizeArtifactName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, "Artifact name is required");
  }
  return trimmed.replace(/\\/g, "/");
}

function listCandidatePaths(frameFilename: string): string[] {
  const candidates = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) {
      return;
    }
    const normalized = value.replace(/\\/g, "/").trim();
    if (!normalized) {
      return;
    }
    candidates.add(normalized);
    candidates.add(normalized.replace(/^\//, ""));
    candidates.add(normalized.startsWith("~/") ? normalized.slice(2) : `~/${normalized.replace(/^\//, "")}`);
  };

  add(frameFilename);
  try {
    const url = new URL(frameFilename);
    add(url.pathname);
  } catch {
    // Ignore non-URL filenames.
  }

  const normalized = [...candidates];
  for (const value of normalized) {
    const withoutMap = value.endsWith(".map") ? value.slice(0, -4) : value;
    add(withoutMap);
    add(withoutMap.endsWith(".js") ? `${withoutMap}.map` : `${withoutMap}.js.map`);
    add(path.posix.basename(withoutMap));
    add(`${path.posix.basename(withoutMap)}.map`);
  }

  return [...candidates];
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapFrame(
  frame: UnknownRecord,
  artifactMap: Map<string, SourceMapLookupArtifact>,
  debugIdArtifactMap: Map<string, SourceMapLookupArtifact>,
  debugMetaByCodeFile: Map<string, string>,
  cache: Map<string, SourceMapConsumer>,
  sourceMapCache: Map<string, ParsedSourceMapArtifact>,
): UnknownRecord {
  const filename = typeof frame.filename === "string" ? frame.filename : "";
  const line = typeof frame.lineno === "number" ? frame.lineno : Number(frame.lineno);
  const column = typeof frame.colno === "number" ? frame.colno : Number(frame.colno);
  if (!filename || !Number.isFinite(line) || !Number.isFinite(column)) {
    return frame;
  }

  let artifact = listCandidatePaths(filename)
    .map((candidate) => artifactMap.get(candidate))
    .find(Boolean);

  if (!artifact) {
    const debugId = listCandidatePaths(filename)
      .map((candidate) => debugMetaByCodeFile.get(candidate))
      .find(Boolean);
    if (debugId) {
      artifact = debugIdArtifactMap.get(debugId);
    }
  }

  if (!artifact) {
    return frame;
  }

  let consumer = cache.get(artifact.id);
  if (!consumer) {
    const parsed = sourceMapCache.get(artifact.id);
    consumer = new SourceMapConsumer(parsed?.rawMap ?? {
      version: "3",
      sources: [],
      names: [],
      mappings: "",
    });
    cache.set(artifact.id, consumer);
  }

  const original = consumer.originalPositionFor({
    line,
    column: Math.max(column - 1, 0),
  });

  if (!original.source) {
    return frame;
  }

  return {
    ...frame,
    filename: original.source,
    function: original.name ?? frame.function,
    lineno: original.line ?? frame.lineno,
    colno: typeof original.column === "number" ? original.column + 1 : frame.colno,
    deobfuscated: true,
    compiledFilename: filename,
    sourceMapArtifact: artifact.artifactName,
  };
}

function mapFrames(
  frames: UnknownRecord[],
  artifactMap: Map<string, SourceMapLookupArtifact>,
  debugIdArtifactMap: Map<string, SourceMapLookupArtifact>,
  debugMetaByCodeFile: Map<string, string>,
  cache: Map<string, SourceMapConsumer>,
  sourceMapCache: Map<string, ParsedSourceMapArtifact>,
) {
  let applied = false;
  const mapped = frames.map((frame) => {
    const nextFrame = mapFrame(frame, artifactMap, debugIdArtifactMap, debugMetaByCodeFile, cache, sourceMapCache);
    if (nextFrame !== frame) {
      applied = true;
    }
    return nextFrame;
  });

  return { frames: mapped, applied };
}

function parseSourceMapArtifact(artifact: SourceMapLookupArtifact): ParsedSourceMapArtifact | null {
  if (!artifact.artifactName.endsWith(".map") && !artifact.filePath.endsWith(".map")) {
    return null;
  }

  const mapFile = readFileSync(artifact.filePath, "utf8");
  return {
    artifact,
    rawMap: safeJsonParse<ParsedSourceMapArtifact["rawMap"]>(mapFile, {
      version: "3",
      sources: [],
      names: [],
      mappings: "",
    }),
  };
}

function buildArtifactLookup(parsedArtifacts: ParsedSourceMapArtifact[]) {
  const lookup = new Map<string, SourceMapLookupArtifact>();
  const debugIdLookup = new Map<string, SourceMapLookupArtifact>();
  for (const parsedArtifact of parsedArtifacts) {
    const artifact = parsedArtifact.artifact;
    const artifactName = normalizeArtifactName(artifact.artifactName);
    for (const candidate of listCandidatePaths(artifactName)) {
      if (!lookup.has(candidate)) {
        lookup.set(candidate, artifact);
      }
    }

    if (typeof parsedArtifact.rawMap.file === "string" && parsedArtifact.rawMap.file.trim()) {
      for (const candidate of listCandidatePaths(parsedArtifact.rawMap.file)) {
        if (!lookup.has(candidate)) {
          lookup.set(candidate, artifact);
        }
      }
    }

    const debugId = parsedArtifact.rawMap.debug_id ?? parsedArtifact.rawMap.debugId;
    if (typeof debugId === "string" && debugId.trim() && !debugIdLookup.has(debugId)) {
      debugIdLookup.set(debugId, artifact);
    }
  }
  return { lookup, debugIdLookup };
}

function buildDebugMetaLookup(rawPayload: UnknownRecord) {
  const lookup = new Map<string, string>();
  const debugMeta = rawPayload.debug_meta;
  if (!debugMeta || typeof debugMeta !== "object" || !Array.isArray((debugMeta as UnknownRecord).images)) {
    return lookup;
  }

  for (const image of (debugMeta as UnknownRecord).images as UnknownRecord[]) {
    const codeFile = typeof image.code_file === "string" ? image.code_file : null;
    const debugId = typeof image.debug_id === "string"
      ? image.debug_id
      : typeof image.debugId === "string"
        ? image.debugId
        : null;
    if (!codeFile || !debugId) {
      continue;
    }

    for (const candidate of listCandidatePaths(codeFile)) {
      if (!lookup.has(candidate)) {
        lookup.set(candidate, debugId);
      }
    }
  }

  return lookup;
}

function getProjectById(projectId: string) {
  return one<{ id: string; slug: string; name: string }>(
    "SELECT id, slug, name FROM projects WHERE id = ?",
    [projectId],
  );
}

export function getProjectBySlug(projectSlug: string) {
  return one<{ id: string; slug: string; name: string }>(
    "SELECT id, slug, name FROM projects WHERE slug = ?",
    [projectSlug],
  );
}

function getReleaseArtifacts(projectId: string, release: string) {
  return all<SourceMapLookupArtifact>(
    `
      SELECT id, org, project_id as projectId, project, release, dist, artifact_name as artifactName, checksum, file_path as filePath,
        content_type as contentType, size, uploaded_at as uploadedAt, expires_at as expiresAt
      FROM minimap_artifacts
      WHERE org = ? AND project_id = ? AND release = ?
      ORDER BY uploaded_at DESC
    `,
    [config.EKEEPER_ORG, projectId, normalizeRelease(release)],
  );
}

export function listMinimapArtifacts(
  projectId?: string,
  pagination: { limit?: number; offset?: number } = {},
) {
  ensureStorageRoot();
  const limit = clampLimit(pagination.limit);
  const offset = clampOffset(pagination.offset);
  const where = projectId ? "WHERE project_id = ?" : "";
  const filterParams: SQLQueryBindings[] = projectId ? [projectId] : [];

  const artifacts = all<MinimapArtifact>(
    `
      SELECT id, org, project_id as projectId, project, release, dist, artifact_name as artifactName, checksum, file_path as filePath,
        content_type as contentType, size, uploaded_at as uploadedAt, expires_at as expiresAt
      FROM minimap_artifacts
      ${where}
      ORDER BY uploaded_at DESC
      LIMIT ? OFFSET ?
    `,
    [...filterParams, limit, offset],
  );

  const total = one<{ total: number }>(
    `SELECT COUNT(*) as total FROM minimap_artifacts ${where}`,
    filterParams,
  )?.total ?? 0;

  // Scoped the same way as the listing: the cleanup action on this page runs against
  // the selected project, so this count must match what that action would delete.
  const retentionEligible = countExpiredMinimaps(projectId);

  return { artifacts, total, limit, offset, retentionEligible };
}

/**
 * Number of artifacts a cleanup run would delete: the union of the age-expired set
 * and the set beyond the per-project release limit. Kept to a single query so the
 * list endpoint stays cheap. Pass a projectId to count only that project's artifacts,
 * matching what a project-scoped cleanup run removes.
 */
export function countExpiredMinimaps(projectId?: string) {
  const keep = keepReleases();
  const scopeParams: SQLQueryBindings[] = projectId ? [projectId] : [];
  if (keep <= 0) {
    return one<{ total: number }>(
      `SELECT COUNT(*) as total FROM minimap_artifacts ${ageExpiredWhere(projectId)}`,
      [retentionCutoff(), ...scopeParams],
    )?.total ?? 0;
  }

  return one<{ total: number }>(
    `
      WITH ${rankedReleasesCte(projectId)}
      SELECT COUNT(*) as total FROM (
        SELECT id FROM minimap_artifacts ${ageExpiredWhere(projectId)}
        UNION
        ${overReleaseLimitSelect("a.id AS id")}
      )
    `,
    [...scopeParams, retentionCutoff(), ...scopeParams, keep],
  )?.total ?? 0;
}

export function saveMinimapArtifact(input: {
  org: string;
  projectId: string;
  project: string;
  release: string;
  dist?: string | null;
  artifactName: string;
  contentType?: string | null;
  buffer: Uint8Array;
}) {
  ensureStorageRoot();
  const release = normalizeRelease(input.release);
  const artifactName = normalizeArtifactName(input.artifactName);
  if (!release) {
    throw new HttpError(400, "Release is required");
  }
  if (input.buffer.byteLength === 0) {
    throw new HttpError(400, "Uploaded file is empty");
  }

  const checksum = createHash("sha1").update(input.buffer).digest("hex");
  const existing = all<MinimapArtifact>(
    `
      SELECT id, org, project_id as projectId, project, release, dist, artifact_name as artifactName, checksum, file_path as filePath,
        content_type as contentType, size, uploaded_at as uploadedAt, expires_at as expiresAt
      FROM minimap_artifacts
      WHERE org = ? AND project_id = ? AND release = ? AND artifact_name = ?
      ORDER BY uploaded_at DESC
      LIMIT 1
    `,
    [input.org, input.projectId, release, artifactName],
  )[0];

  if (existing) {
    if (existsSync(existing.filePath)) {
      rmSync(existing.filePath, { force: true });
    }
    run("DELETE FROM minimap_artifacts WHERE id = ?", [existing.id]);
  }

  const id = createId("minimap");
  const extension = path.extname(artifactName) || ".map";
  const filePath = path.join(storageRoot, `${id}${extension}`);
  const uploadedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + retentionMs()).toISOString();

  writeFileSync(filePath, input.buffer);
  console.log("[minimaps] saving artifact", {
    org: input.org,
    projectId: input.projectId,
    project: input.project,
    release,
    artifactName,
    filePath,
    size: input.buffer.byteLength,
  });
  run(
    `INSERT INTO minimap_artifacts (
      id, org, project_id, project, release, dist, artifact_name, checksum, file_path, content_type, size, uploaded_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.org,
      input.projectId,
      input.project,
      release,
      input.dist ?? null,
      artifactName,
      checksum,
      filePath,
      input.contentType ?? null,
      input.buffer.byteLength,
      uploadedAt,
      expiresAt,
    ],
  );

  return {
    id,
    org: input.org,
    projectId: input.projectId,
    project: input.project,
    release,
    dist: input.dist ?? null,
    artifactName,
    checksum,
    filePath,
    contentType: input.contentType ?? null,
    size: input.buffer.byteLength,
    uploadedAt,
    expiresAt,
  } satisfies MinimapArtifact;
}

export function isMinimapCleanupRunning() {
  return cleanupRunning;
}

/**
 * Collects everything a cleanup run should delete: artifacts past the age-based
 * retention window merged with artifacts belonging to releases beyond the
 * per-project keep limit. Deduped by artifact id. Mirrors `countExpiredMinimaps`,
 * including the optional project scope, so the count and the deletion agree.
 */
function collectCleanupCandidates(projectId?: string) {
  const candidates = new Map<string, string>();
  const scopeParams: SQLQueryBindings[] = projectId ? [projectId] : [];

  for (const artifact of all<{ id: string; filePath: string }>(
    `SELECT id, file_path as filePath FROM minimap_artifacts ${ageExpiredWhere(projectId)}`,
    [retentionCutoff(), ...scopeParams],
  )) {
    candidates.set(artifact.id, artifact.filePath);
  }

  const keep = keepReleases();
  if (keep > 0) {
    for (const artifact of all<{ id: string; filePath: string }>(
      `WITH ${rankedReleasesCte(projectId)} ${overReleaseLimitSelect("a.id AS id, a.file_path AS filePath")}`,
      [...scopeParams, keep],
    )) {
      candidates.set(artifact.id, artifact.filePath);
    }
  }

  return [...candidates].map(([id, filePath]) => ({ id, filePath }));
}

/**
 * Removes files under the storage root that no artifact row references any more.
 * Comparison is by basename because every stored file is written directly into
 * the storage root as `<artifact id><ext>`.
 *
 * Ordering matters: the directory listing is taken first and the referenced set is
 * read synchronously afterwards. Doing it the other way round would let an upload
 * that lands during the readdir await appear in the listing but not in the set,
 * and the sweep would delete a file whose row exists. The mtime guard below is a
 * second line of defence for writes that race the sweep itself.
 */
async function sweepOrphanFiles() {
  const entries = await readdir(storageRoot, { withFileTypes: true });

  // Read after the listing so the set can only ever be a superset of what was listed.
  const referenced = new Set(
    all<{ filePath: string }>("SELECT file_path as filePath FROM minimap_artifacts")
      .map((row) => path.basename(row.filePath)),
  );

  const resolvedRoot = path.resolve(storageRoot);
  const candidates = entries
    .filter((entry) => entry.isFile() && !referenced.has(entry.name))
    .map((entry) => path.join(storageRoot, entry.name))
    // Defensive: never touch anything that resolved outside the storage root.
    .filter((filePath) => path.dirname(path.resolve(filePath)) === resolvedRoot);

  const minAge = Date.now() - ORPHAN_MIN_AGE_MS;
  let removed = 0;

  for (let index = 0; index < candidates.length; index += CLEANUP_BATCH_SIZE) {
    for (const filePath of candidates.slice(index, index + CLEANUP_BATCH_SIZE)) {
      try {
        // Skip freshly written files: an upload may have created the file and not
        // yet committed its row.
        const stats = await stat(filePath);
        if (stats.mtimeMs > minAge) {
          continue;
        }
        await rm(filePath, { force: true });
        removed += 1;
      } catch (error) {
        console.error("[minimaps] failed to delete orphan file", { filePath, error });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return removed;
}

/**
 * Deletes expired artifacts off the request path. Files are removed with the
 * promise-based fs API and rows are deleted in small batches so a large cleanup
 * never blocks the event loop. With a projectId only that project's artifacts are
 * removed; the orphan sweep is skipped in that mode because a file with no row
 * cannot be attributed to a project.
 */
export async function cleanupExpiredMinimapsAsync(projectId?: string) {
  if (cleanupRunning) {
    return { started: false, deleted: 0 };
  }

  cleanupRunning = true;
  let deleted = 0;
  let failed = 0;

  try {
    ensureStorageRoot();
    const expired = collectCleanupCandidates(projectId);

    for (let index = 0; index < expired.length; index += CLEANUP_BATCH_SIZE) {
      const batch = expired.slice(index, index + CLEANUP_BATCH_SIZE);
      for (const artifact of batch) {
        try {
          await rm(artifact.filePath, { force: true });
          run("DELETE FROM minimap_artifacts WHERE id = ?", [artifact.id]);
          deleted += 1;
        } catch (error) {
          failed += 1;
          console.error("[minimaps] failed to delete expired artifact", {
            artifactId: artifact.id,
            filePath: artifact.filePath,
            error,
          });
        }
      }
      // Yield between batches so the server keeps serving requests.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Orphans belong to no project, so only a global run is allowed to sweep them.
    const orphansRemoved = projectId ? 0 : await sweepOrphanFiles();

    console.log("[minimaps] async cleanup finished", {
      projectId: projectId ?? null,
      deleted,
      failed,
      eligible: expired.length,
      orphansRemoved,
    });
    return { started: true, deleted };
  } finally {
    cleanupRunning = false;
  }
}

/**
 * Runs retention cleanup shortly after boot and then once a day. The
 * `cleanupRunning` guard inside the cleanup makes overlapping ticks a no-op.
 */
export function startMinimapRetentionScheduler() {
  console.log("[minimaps] scheduling retention cleanup", {
    retentionDays: config.MINIMAPS_RETENTION_DAYS,
    keepReleases: config.MINIMAPS_KEEP_RELEASES,
    initialDelayMs: SCHEDULED_CLEANUP_DELAY_MS,
    intervalMs: SCHEDULED_CLEANUP_INTERVAL_MS,
  });

  const runScheduledCleanup = () => {
    console.log("[minimaps] scheduled cleanup starting");
    void cleanupExpiredMinimapsAsync().catch((error) => {
      console.error("[minimaps] scheduled cleanup failed", error);
    });
  };

  setTimeout(runScheduledCleanup, SCHEDULED_CLEANUP_DELAY_MS);
  return setInterval(runScheduledCleanup, SCHEDULED_CLEANUP_INTERVAL_MS);
}

export function deobfuscateEvent(input: {
  projectId: string;
  rawPayload: string;
  stacktrace: string | UnknownRecord | null;
  exception: string | UnknownRecord;
}): DeobfuscationResult {
  const rawPayload = safeJsonParse<UnknownRecord>(input.rawPayload, {});
  const release = typeof rawPayload.release === "string" ? rawPayload.release : null;
  const stacktrace = typeof input.stacktrace === "string"
    ? safeJsonParse<UnknownRecord | null>(input.stacktrace, null)
    : input.stacktrace;
  const exception = typeof input.exception === "string"
    ? safeJsonParse<UnknownRecord>(input.exception, {})
    : input.exception;

  if (!release) {
    return { stacktrace, exception, applied: false, release: null };
  }

  const project = getProjectById(input.projectId);
  if (!project) {
    return { stacktrace, exception, applied: false, release };
  }

  const parsedArtifacts = getReleaseArtifacts(project.id, release)
    .map(parseSourceMapArtifact)
    .filter((artifact): artifact is ParsedSourceMapArtifact => Boolean(artifact));
  if (parsedArtifacts.length === 0) {
    return { stacktrace, exception, applied: false, release };
  }

  const { lookup: artifactMap, debugIdLookup: debugIdArtifactMap } = buildArtifactLookup(parsedArtifacts);
  const sourceMapCache = new Map(parsedArtifacts.map((artifact) => [artifact.artifact.id, artifact]));
  const debugMetaByCodeFile = buildDebugMetaLookup(rawPayload);
  const cache = new Map<string, SourceMapConsumer>();
  let applied = false;

  const nextStacktrace =
    stacktrace && Array.isArray(stacktrace.frames)
      ? (() => {
          const result = mapFrames(
            stacktrace.frames as UnknownRecord[],
            artifactMap,
            debugIdArtifactMap,
            debugMetaByCodeFile,
            cache,
            sourceMapCache,
          );
          applied = applied || result.applied;
          return { ...stacktrace, frames: result.frames };
        })()
      : stacktrace;

  const nextException = { ...exception };
  if (Array.isArray(nextException.values)) {
    nextException.values = (nextException.values as UnknownRecord[]).map((value) => {
      if (!value.stacktrace || typeof value.stacktrace !== "object" || !Array.isArray((value.stacktrace as UnknownRecord).frames)) {
        return value;
      }

      const result = mapFrames(
        (value.stacktrace as UnknownRecord).frames as UnknownRecord[],
        artifactMap,
        debugIdArtifactMap,
        debugMetaByCodeFile,
        cache,
        sourceMapCache,
      );
      applied = applied || result.applied;
      return {
        ...value,
        stacktrace: {
          ...(value.stacktrace as UnknownRecord),
          frames: result.frames,
        },
      };
    });
  }

  return {
    stacktrace: nextStacktrace,
    exception: nextException,
    applied,
    release,
  };
}
