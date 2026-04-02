import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { unzipSync } from "fflate";
import { config } from "../config";
import { one, run } from "../db/sqlite";
import { HttpError } from "../lib/http";
import { createId } from "../lib/ids";
import { getProjectBySlug, saveMinimapArtifact } from "../lib/minimaps";
import { getServerAuthToken } from "../lib/server-settings";

const chunkUploadRoot = path.resolve(import.meta.dir, "../../..", "backend/data/chunk-upload");

function ensureChunkUploadRoot() {
  mkdirSync(chunkUploadRoot, { recursive: true });
}

function chunkPath(checksum: string) {
  ensureChunkUploadRoot();
  return path.join(chunkUploadRoot, checksum);
}

function sha1(buffer: Uint8Array) {
  return createHash("sha1").update(buffer).digest("hex");
}

function concatenateChunks(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function requirePluginAuth(authHeader: string | undefined) {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing upload token");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (token !== getServerAuthToken()) {
    throw new HttpError(403, "Invalid upload token");
  }
}

function validateOrgProject(org: string, project?: string) {
  if (org !== config.EKEEPER_ORG) {
    throw new HttpError(400, "Unexpected organization");
  }

  if (project && !getProjectBySlug(project)) {
    throw new HttpError(400, "Unknown project slug");
  }
}

function validateProjectList(projects: string[]) {
  if (projects.length === 0) {
    throw new HttpError(400, "At least one project slug is required");
  }
  for (const project of projects) {
    validateOrgProject(config.EKEEPER_ORG, project);
  }
}

async function saveReleaseFile(ctx: Context, releaseFromPath?: string) {
  requirePluginAuth(ctx.req.header("authorization"));
  const params = ctx.req.param();
  const org = params.org;
  const project = typeof params.project === "string" ? params.project : undefined;
  validateOrgProject(org, project);

  const formData = await ctx.req.formData();
  const file = formData.get("file") ?? formData.get("upload");
  if (!(file instanceof File)) {
    throw new HttpError(400, "A source map upload is required");
  }

  const release = releaseFromPath ?? String(formData.get("release") ?? "");
  if (!release) {
    throw new HttpError(400, "Release is required");
  }

  const artifactName = String(
    formData.get("name") ??
      formData.get("artifactName") ??
      formData.get("url") ??
      file.name,
  );
  const resolvedProjectSlug = project ?? String(formData.get("project") ?? "");
  const resolvedProject = getProjectBySlug(resolvedProjectSlug);
  if (!resolvedProject) {
    throw new HttpError(400, "A valid project slug is required");
  }

  console.log("[plugin] release file upload", {
    route: ctx.req.path,
    org,
    project: resolvedProject.slug,
    release,
    artifactName,
    dist: formData.get("dist") ? String(formData.get("dist")) : null,
    fileName: file.name,
    fileType: file.type || null,
    fileSize: file.size,
  });

  const artifact = saveMinimapArtifact({
    org,
    projectId: resolvedProject.id,
    project: resolvedProject.slug,
    release,
    dist: formData.get("dist") ? String(formData.get("dist")) : null,
    artifactName,
    contentType: file.type || null,
    buffer: new Uint8Array(await file.arrayBuffer()),
  });

  return ctx.json(artifactResponse(artifact));
}

export const pluginRouter = new Hono();

function projectResponse(projectSlug?: string) {
  return projectSlug ? [{ slug: projectSlug, name: projectSlug }] : [];
}

interface StoredRelease {
  id: string;
  org: string;
  projectSlug: string | null;
  version: string;
  dateCreated: string;
  dateReleased: string | null;
}

interface ReleaseFileResponse {
  id: string;
  name: string;
  sha1: string;
  size: number;
  headers: Record<string, string>;
  dateCreated: string;
  dist: string | null;
  mimeType: string | null;
}

function artifactResponse(artifact: {
  id: string;
  artifactName: string;
  checksum: string;
  size: number;
  uploadedAt: string;
  dist: string | null;
  contentType: string | null;
}): ReleaseFileResponse {
  return {
    id: artifact.id,
    name: artifact.artifactName,
    sha1: artifact.checksum,
    size: artifact.size,
    headers: {},
    dateCreated: artifact.uploadedAt,
    dist: artifact.dist,
    mimeType: artifact.contentType,
  };
}

function releaseResponseFromRecord(record: StoredRelease, projects: Array<{ slug: string; name: string }>) {
  return {
    version: record.version,
    dateCreated: record.dateCreated,
    dateReleased: record.dateReleased,
    lastEvent: null,
    newGroups: 0,
    projects,
  };
}

function findRelease(org: string, version: string, projectSlug?: string | null) {
  return one<StoredRelease>(
    `
      SELECT id, org, project_slug as projectSlug, version, date_created as dateCreated, date_released as dateReleased
      FROM sentry_releases
      WHERE org = ? AND COALESCE(project_slug, '') = COALESCE(?, '') AND version = ?
    `,
    [org, projectSlug ?? null, version],
  );
}

function findLatestRelease(org: string, projectSlug?: string | null) {
  return one<StoredRelease>(
    `
      SELECT id, org, project_slug as projectSlug, version, date_created as dateCreated, date_released as dateReleased
      FROM sentry_releases
      WHERE org = ? AND COALESCE(project_slug, '') = COALESCE(?, '')
      ORDER BY date_created DESC
      LIMIT 1
    `,
    [org, projectSlug ?? null],
  );
}

function createOrUpdateRelease(org: string, version: string, projectSlug?: string | null) {
  const existing = findRelease(org, version, projectSlug);
  if (existing) {
    console.log("[plugin] release already exists", {
      org,
      projectSlug: projectSlug ?? null,
      version,
      releaseId: existing.id,
    });
    run(
      `UPDATE sentry_releases SET updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), existing.id],
    );
    return existing;
  }

  const now = new Date().toISOString();
  const record: StoredRelease = {
    id: createId("release"),
    org,
    projectSlug: projectSlug ?? null,
    version,
    dateCreated: now,
    dateReleased: null,
  };
  run(
    `INSERT INTO sentry_releases (id, org, project_slug, version, date_created, date_released, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.org, record.projectSlug, record.version, record.dateCreated, record.dateReleased, now, now],
  );
  console.log("[plugin] created release", {
    org,
    projectSlug: projectSlug ?? null,
    version,
    releaseId: record.id,
  });
  return record;
}

function finalizeRelease(org: string, version: string, projectSlug?: string | null) {
  const existing = findRelease(org, version, projectSlug);
  if (!existing) {
    throw new HttpError(404, "Release not found");
  }

  const now = new Date().toISOString();
  run(
    `UPDATE sentry_releases
     SET date_released = ?, updated_at = ?
     WHERE id = ?`,
    [now, now, existing.id],
  );

  console.log("[plugin] finalized release", {
    org,
    projectSlug: projectSlug ?? null,
    version,
    releaseId: existing.id,
  });

  return {
    ...existing,
    dateReleased: now,
  };
}

function listReleaseFiles(org: string, release: string, projectSlug: string) {
  const project = getProjectBySlug(projectSlug);
  if (!project) {
    throw new HttpError(404, "Project not found");
  }

  const rawFiles = one<{ files: string } | null>(
    `
      SELECT json_group_array(
        json_object(
          'id', id,
          'name', artifact_name,
          'sha1', checksum,
          'size', size,
          'headers', json('{}'),
          'dateCreated', uploaded_at,
          'dist', dist,
          'mimeType', content_type
        )
      ) as files
      FROM minimap_artifacts
      WHERE org = ? AND project_id = ? AND release = ?
    `,
    [org, project.id, release],
  )?.files;

  if (!rawFiles) {
    return [];
  }

  return JSON.parse(rawFiles) as ReleaseFileResponse[];
}

function releaseFilesResponse(ctx: Context, projectSlug: string) {
  const org = ctx.req.param("org");
  const release = ctx.req.param("release");
  if (!org || !release) {
    throw new HttpError(400, "Organization and release are required");
  }

  validateOrgProject(org, projectSlug);
  const checksumFilters = new URL(ctx.req.url).searchParams.getAll("checksum");
  const files = listReleaseFiles(org, release, projectSlug);
  const filtered = checksumFilters.length > 0
    ? files.filter((file) => checksumFilters.includes(file.sha1))
    : files;

  console.log("[plugin] release files lookup", {
    route: ctx.req.path,
    org,
    project: projectSlug,
    release,
    checksumFilters,
    matched: filtered.length,
  });

  return ctx.json(filtered, 200, {
    Link: "",
  });
}

async function saveSourceMapFile(ctx: Context) {
  requirePluginAuth(ctx.req.header("authorization"));
  const params = ctx.req.param();
  const org = params.org;
  const project = typeof params.project === "string" ? params.project : undefined;
  validateOrgProject(org, project);

  const resolvedProjectSlug = project ?? ctx.req.query("project") ?? "";
  const resolvedProject = getProjectBySlug(resolvedProjectSlug);
  if (!resolvedProject) {
    throw new HttpError(400, "A valid project slug is required");
  }

  const formData = await ctx.req.formData();
  const file = formData.get("file") ?? formData.get("upload");
  if (!(file instanceof File)) {
    throw new HttpError(400, "A source map upload is required");
  }

  const latestRelease = findLatestRelease(org, resolvedProject.slug);
  const release = String(formData.get("release") ?? ctx.req.query("release") ?? latestRelease?.version ?? "");
  if (!release) {
    throw new HttpError(400, "Release is required");
  }

  const artifactName = String(
    ctx.req.query("name") ??
      formData.get("name") ??
      formData.get("artifactName") ??
      file.name,
  );

  console.log("[plugin] source-maps upload", {
    route: ctx.req.path,
    org,
    project: resolvedProject.slug,
    release,
    artifactName,
    queryName: ctx.req.query("name") ?? null,
    fileName: file.name,
    fileType: file.type || null,
    fileSize: file.size,
  });

  const artifact = saveMinimapArtifact({
    org,
    projectId: resolvedProject.id,
    project: resolvedProject.slug,
    release,
    dist: formData.get("dist") ? String(formData.get("dist")) : null,
    artifactName,
    contentType: file.type || null,
    buffer: new Uint8Array(await file.arrayBuffer()),
  });

  return ctx.json(artifactResponse(artifact));
}

async function uploadChunks(ctx: Context) {
  requirePluginAuth(ctx.req.header("authorization"));
  const org = ctx.req.param("org");
  if (!org) {
    throw new HttpError(400, "Organization is required");
  }
  validateOrgProject(org);

  const formData = await ctx.req.formData();
  const savedChecksums: string[] = [];
  for (const value of formData.values()) {
    if (
      !value ||
      typeof value !== "object" ||
      !("arrayBuffer" in value) ||
      !("name" in value)
    ) {
      continue;
    }

    const file = value as File;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = file.name || sha1(bytes);
    writeFileSync(chunkPath(checksum), bytes);
    savedChecksums.push(checksum);
  }

  console.log("[plugin] chunk upload", {
    route: ctx.req.path,
    org,
    chunks: savedChecksums,
  });

  return ctx.json({ state: "ok", chunks: savedChecksums });
}

async function assembleArtifactBundle(ctx: Context) {
  requirePluginAuth(ctx.req.header("authorization"));
  const org = ctx.req.param("org");
  if (!org) {
    throw new HttpError(400, "Organization is required");
  }
  validateOrgProject(org);

  const payload = await ctx.req.json() as {
    checksum?: string;
    chunks?: string[];
    projects?: string[];
    version?: string;
    dist?: string | null;
  };

  const projects = Array.isArray(payload.projects)
    ? payload.projects.filter((project): project is string => typeof project === "string" && project.length > 0)
    : [];
  validateProjectList(projects);

  if (!payload.checksum || !Array.isArray(payload.chunks) || payload.chunks.length === 0) {
    throw new HttpError(400, "Artifact bundle checksum and chunks are required");
  }

  const missingChunks = payload.chunks.filter((checksum) => {
    try {
      readFileSync(chunkPath(checksum));
      return false;
    } catch {
      return true;
    }
  });

  if (missingChunks.length > 0) {
    console.log("[plugin] artifact bundle assemble missing chunks", {
      org,
      checksum: payload.checksum,
      missingChunks,
    });
    return ctx.json({ state: "not_found", missingChunks }, 409);
  }

  const chunkBuffers = payload.chunks.map((checksum) => new Uint8Array(readFileSync(chunkPath(checksum))));
  const bundleBytes = concatenateChunks(chunkBuffers);
  const bundleChecksum = sha1(bundleBytes);

  console.log("[plugin] artifact bundle assemble", {
    org,
    projects,
    release: payload.version ?? null,
    checksum: payload.checksum,
    computedChecksum: bundleChecksum,
    chunkCount: payload.chunks.length,
    size: bundleBytes.byteLength,
  });

  const entries = unzipSync(bundleBytes);
  const savedArtifacts: string[] = [];
  for (const projectSlug of projects) {
    const project = getProjectBySlug(projectSlug);
    if (!project) {
      continue;
    }

    for (const [entryName, content] of Object.entries(entries)) {
      if (!entryName.endsWith(".map")) {
        continue;
      }

      const artifact = saveMinimapArtifact({
        org,
        projectId: project.id,
        project: project.slug,
        release: payload.version ?? "artifact-bundle",
        dist: payload.dist ?? null,
        artifactName: entryName,
        contentType: "application/json",
        buffer: content,
      });
      savedArtifacts.push(artifact.id);
    }
  }

  for (const checksum of payload.chunks) {
    try {
      unlinkSync(chunkPath(checksum));
    } catch {
      // Ignore cleanup failures.
    }
  }

  return ctx.json({
    state: "created",
    artifactBundle: {
      checksum: payload.checksum,
      release: payload.version ?? null,
      projects,
      artifactCount: savedArtifacts.length,
    },
  });
}

pluginRouter.post("/organizations/:org/releases", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  return ctx.req.json()
    .then((payload) => {
      const projects = Array.isArray(payload.projects)
        ? payload.projects
            .map((project: unknown) => (typeof project === "string" ? project : null))
            .filter((project: string | null): project is string => Boolean(project))
        : [];
      const version = String(payload.version ?? "unknown");
      const release = createOrUpdateRelease(ctx.req.param("org"), version, null);
      return ctx.json(
        releaseResponseFromRecord(
          release,
          projects.map((project: string) => ({ slug: project, name: project })),
        ),
      );
    })
    .catch(() => {
      const release = createOrUpdateRelease(ctx.req.param("org"), "unknown", null);
      return ctx.json(releaseResponseFromRecord(release, []));
    });
});

pluginRouter.post("/organizations/:org/releases/", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  return ctx.req.json()
    .then((payload) => {
      const projects = Array.isArray(payload.projects)
        ? payload.projects
            .map((project: unknown) => (typeof project === "string" ? project : null))
            .filter((project: string | null): project is string => Boolean(project))
        : [];
      const version = String(payload.version ?? "unknown");
      const release = createOrUpdateRelease(ctx.req.param("org"), version, null);
      return ctx.json(
        releaseResponseFromRecord(
          release,
          projects.map((project: string) => ({ slug: project, name: project })),
        ),
      );
    })
    .catch(() => {
      const release = createOrUpdateRelease(ctx.req.param("org"), "unknown", null);
      return ctx.json(releaseResponseFromRecord(release, []));
    });
});

pluginRouter.post("/projects/:org/:project/releases", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"), ctx.req.param("project"));
  return ctx.req.json()
    .then((payload) => {
      const release = createOrUpdateRelease(
        ctx.req.param("org"),
        String(payload.version ?? "unknown"),
        ctx.req.param("project"),
      );
      return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
    })
    .catch(() => {
      const release = createOrUpdateRelease(ctx.req.param("org"), "unknown", ctx.req.param("project"));
      return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
    });
});

pluginRouter.post("/projects/:org/:project/releases/", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"), ctx.req.param("project"));
  return ctx.req.json()
    .then((payload) => {
      const release = createOrUpdateRelease(
        ctx.req.param("org"),
        String(payload.version ?? "unknown"),
        ctx.req.param("project"),
      );
      return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
    })
    .catch(() => {
      const release = createOrUpdateRelease(ctx.req.param("org"), "unknown", ctx.req.param("project"));
      return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
    });
});

pluginRouter.get("/organizations/:org/releases/:release", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  const release = findRelease(ctx.req.param("org"), ctx.req.param("release"), null);
  if (!release) {
    throw new HttpError(404, "Release not found");
  }
  return ctx.json(releaseResponseFromRecord(release, []));
});

pluginRouter.get("/organizations/:org/releases/:release/", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  const release = findRelease(ctx.req.param("org"), ctx.req.param("release"), null);
  if (!release) {
    throw new HttpError(404, "Release not found");
  }
  return ctx.json(releaseResponseFromRecord(release, []));
});

pluginRouter.get("/projects/:org/:project/releases/:release", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"), ctx.req.param("project"));
  const release = findRelease(ctx.req.param("org"), ctx.req.param("release"), ctx.req.param("project"));
  if (!release) {
    throw new HttpError(404, "Release not found");
  }
  return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
});

pluginRouter.get("/projects/:org/:project/releases/:release/", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"), ctx.req.param("project"));
  const release = findRelease(ctx.req.param("org"), ctx.req.param("release"), ctx.req.param("project"));
  if (!release) {
    throw new HttpError(404, "Release not found");
  }
  return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
});

pluginRouter.get("/projects/:org/:project/releases/:release/files", (ctx) =>
  releaseFilesResponse(ctx, ctx.req.param("project")),
);

pluginRouter.get("/projects/:org/:project/releases/:release/files/", (ctx) =>
  releaseFilesResponse(ctx, ctx.req.param("project")),
);

pluginRouter.put("/organizations/:org/releases/:release", async (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  const payload = await ctx.req.json().catch(() => ({}));
  const version = String((payload as { version?: string }).version ?? ctx.req.param("release"));
  const release = finalizeRelease(ctx.req.param("org"), version, null);
  return ctx.json(releaseResponseFromRecord(release, []));
});

pluginRouter.put("/organizations/:org/releases/:release/", async (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  const payload = await ctx.req.json().catch(() => ({}));
  const version = String((payload as { version?: string }).version ?? ctx.req.param("release"));
  const release = finalizeRelease(ctx.req.param("org"), version, null);
  return ctx.json(releaseResponseFromRecord(release, []));
});

pluginRouter.put("/projects/:org/:project/releases/:release", async (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"), ctx.req.param("project"));
  const payload = await ctx.req.json().catch(() => ({}));
  const version = String((payload as { version?: string }).version ?? ctx.req.param("release"));
  const release = finalizeRelease(ctx.req.param("org"), version, ctx.req.param("project"));
  return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
});

pluginRouter.put("/projects/:org/:project/releases/:release/", async (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"), ctx.req.param("project"));
  const payload = await ctx.req.json().catch(() => ({}));
  const version = String((payload as { version?: string }).version ?? ctx.req.param("release"));
  const release = finalizeRelease(ctx.req.param("org"), version, ctx.req.param("project"));
  return ctx.json(releaseResponseFromRecord(release, projectResponse(ctx.req.param("project"))));
});

pluginRouter.post("/projects/:org/:project/releases/:release/files", (ctx) =>
  saveReleaseFile(ctx, ctx.req.param("release")),
);

pluginRouter.post("/projects/:org/:project/releases/:release/files/", (ctx) =>
  saveReleaseFile(ctx, ctx.req.param("release")),
);

pluginRouter.post("/organizations/:org/releases/:release/files", (ctx) =>
  saveReleaseFile(ctx, ctx.req.param("release")),
);

pluginRouter.post("/organizations/:org/releases/:release/files/", (ctx) =>
  saveReleaseFile(ctx, ctx.req.param("release")),
);

pluginRouter.get("/organizations/:org/chunk-upload", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  return ctx.json({
    url: `${config.APP_URL.replace(/\/+$/, "")}/api/0/organizations/${ctx.req.param("org")}/chunk-upload/`,
    chunkSize: 8 * 1024 * 1024,
    chunksPerRequest: 64,
    maxFileSize: 2 * 1024 * 1024 * 1024,
    maxRequestSize: 32 * 1024 * 1024,
    concurrency: 8,
    hashAlgorithm: "sha1",
    compression: [],
    accept: ["artifact_bundles_v2"],
  });
});

pluginRouter.get("/organizations/:org/chunk-upload/", (ctx) => {
  requirePluginAuth(ctx.req.header("authorization"));
  validateOrgProject(ctx.req.param("org"));
  return ctx.json({
    url: `${config.APP_URL.replace(/\/+$/, "")}/api/0/organizations/${ctx.req.param("org")}/chunk-upload/`,
    chunkSize: 8 * 1024 * 1024,
    chunksPerRequest: 64,
    maxFileSize: 2 * 1024 * 1024 * 1024,
    maxRequestSize: 32 * 1024 * 1024,
    concurrency: 8,
    hashAlgorithm: "sha1",
    compression: [],
    accept: ["artifact_bundles_v2"],
  });
});

pluginRouter.post("/organizations/:org/chunk-upload", (ctx) => uploadChunks(ctx));
pluginRouter.post("/organizations/:org/chunk-upload/", (ctx) => uploadChunks(ctx));

pluginRouter.post("/organizations/:org/artifactbundle/assemble", (ctx) => assembleArtifactBundle(ctx));
pluginRouter.post("/organizations/:org/artifactbundle/assemble/", (ctx) => assembleArtifactBundle(ctx));

pluginRouter.post("/projects/:org/:project/files/source-maps", (ctx) =>
  saveSourceMapFile(ctx),
);

pluginRouter.post("/projects/:org/:project/files/source-maps/", (ctx) =>
  saveSourceMapFile(ctx),
);
