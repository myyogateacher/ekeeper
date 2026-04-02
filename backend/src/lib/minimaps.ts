import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const storageRoot = path.isAbsolute(config.MINIMAPS_STORAGE_PATH)
  ? config.MINIMAPS_STORAGE_PATH
  : path.resolve(import.meta.dir, "../../..", config.MINIMAPS_STORAGE_PATH);

function ensureStorageRoot() {
  mkdirSync(storageRoot, { recursive: true });
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

export function listMinimapArtifacts(projectId?: string) {
  ensureStorageRoot();
  return all<MinimapArtifact>(
    `
      SELECT id, org, project_id as projectId, project, release, dist, artifact_name as artifactName, checksum, file_path as filePath,
        content_type as contentType, size, uploaded_at as uploadedAt, expires_at as expiresAt
      FROM minimap_artifacts
      ${projectId ? "WHERE project_id = ?" : ""}
      ORDER BY uploaded_at DESC
    `,
    projectId ? [projectId] : [],
  );
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
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

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

export function cleanupExpiredMinimaps() {
  ensureStorageRoot();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expired = all<MinimapArtifact>(
    `
      SELECT id, org, project_id as projectId, project, release, dist, artifact_name as artifactName, checksum, file_path as filePath,
        content_type as contentType, size, uploaded_at as uploadedAt, expires_at as expiresAt
      FROM minimap_artifacts
      WHERE uploaded_at < ?
    `,
    [cutoff],
  );

  for (const artifact of expired) {
    if (existsSync(artifact.filePath)) {
      rmSync(artifact.filePath, { force: true });
    }
    run("DELETE FROM minimap_artifacts WHERE id = ?", [artifact.id]);
  }

  if (expired.length > 0) {
    console.log("[minimaps] cleaned expired artifacts", {
      deleted: expired.length,
      artifactIds: expired.map((artifact) => artifact.id),
    });
  }

  return {
    deleted: expired.length,
    artifacts: expired,
  };
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
