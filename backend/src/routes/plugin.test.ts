import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { Hono } from "hono";
import { config } from "../config";
import { all, run } from "../db/sqlite";
import { getServerAuthToken } from "../lib/server-settings";
import { pluginRouter } from "./plugin";

// Shaped on routes/mcp.test.ts: the router is mounted on a bare Hono app and driven with app.request, with a
// real project row in the configured SQLite. The Sentry client (@sentry/vite-plugin 11.9.0, which drives the
// sentry CLI) is the other party in every test here, so each assertion is about what that client does with
// the answer, not about how the handler is written.

const suffix = Math.random().toString(36).slice(2, 8);
const projectSlug = `plugin-test-${suffix}`;
const projectId = `p_plugin_${suffix}`;
const now = new Date().toISOString();
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [projectId, `Plugin ${suffix}`, projectSlug, "production", 1, now, now]);

const app = new Hono();
app.route("/api/0", pluginRouter);
const org = config.EKEEPER_ORG;
const headers = { Authorization: `Bearer ${getServerAuthToken()}` };
const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

// Where plugin.ts keeps uploaded chunks until assemble consumes them (chunkUploadRoot there).
const chunkFile = (checksum: string) => path.resolve(import.meta.dir, "../../data/chunk-upload", checksum);
const uploadedChunks: string[] = [];

const uploadChunk = async (bytes: Uint8Array) => {
  const checksum = sha1(bytes);
  uploadedChunks.push(checksum);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), checksum);
  const res = await app.request(`/api/0/organizations/${org}/chunk-upload/`, { method: "POST", headers, body: form });
  expect(res.status).toBe(200);
  return checksum;
};

// The artifact bundle the sentry CLI builds: manifest.json plus one entry per file, named
// `_/_/<debug id>-0.js.map` for a debug-id upload (entry names copied from a real local build of
// @sentry/vite-plugin 11.9.0), with the debug id also written into the map itself.
const debugId = "906175b9-9fef-4646-af40-a9af3f33089d";
const mapName = `_/_/${debugId}-0.js.map`;
const bundle = () =>
  zipSync({
    "manifest.json": strToU8(JSON.stringify({ org, project: projectSlug, files: { [mapName]: { url: "~/assets/index-CfcGECQr.js", type: "source_map" } } })),
    [mapName]: strToU8(JSON.stringify({ version: 3, file: "index-CfcGECQr.js", sources: ["../../src/join.js"], names: [], mappings: "AAAA", debug_id: debugId, debugId })),
  });

const assemble = (body: Record<string, unknown>) =>
  app.request(`/api/0/organizations/${org}/artifactbundle/assemble/`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

afterAll(() => {
  for (const checksum of uploadedChunks) rmSync(chunkFile(checksum), { force: true });
  run(`DELETE FROM minimap_artifacts WHERE project_id = ?`, [projectId]);
  run(`DELETE FROM projects WHERE id = ?`, [projectId]);
});

describe("artifact bundle assemble", () => {
  test("a bundle whose chunks are not uploaded yet answers 200 not_found with the missing checksums, so the client uploads them", async () => {
    const checksum = sha1(new TextEncoder().encode(`never uploaded ${suffix}`));

    const res = await assemble({ checksum, chunks: [checksum], projects: [projectSlug], version: `rel-${suffix}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "not_found", missingChunks: [checksum] });
  });

  test("a partly uploaded bundle lists only the chunks still missing", async () => {
    const uploaded = await uploadChunk(strToU8(`chunk one ${suffix}`));
    const missing = sha1(strToU8(`chunk two ${suffix}`));

    const res = await assemble({ checksum: sha1(strToU8(`whole ${suffix}`)), chunks: [uploaded, missing], projects: [projectSlug], version: `rel-${suffix}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "not_found", missingChunks: [missing] });
  });

  test("once every chunk is uploaded it saves the maps and answers 200 ok, the state that ends the client's wait", async () => {
    const bytes = bundle();
    const checksum = await uploadChunk(bytes);

    const res = await assemble({ checksum, chunks: [checksum], projects: [projectSlug], version: `rel-${suffix}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "ok", missingChunks: [] });
    expect(all(`SELECT release, artifact_name FROM minimap_artifacts WHERE project_id = ?`, [projectId])).toEqual([
      { release: `rel-${suffix}`, artifact_name: mapName },
    ]);
  });
});
