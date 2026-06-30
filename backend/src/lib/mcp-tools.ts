import { getClickHouseClient } from "../db/clickhouse";
import { all, one } from "../db/sqlite";

async function q<T = Record<string, unknown>>(sql: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await getClickHouseClient().query({ query: sql, query_params: params, format: "JSONEachRow" });
  return rs.json<T>();
}

export function accessibleProjectIds(userId: string): string[] {
  const user = one<{ role: string }>(`SELECT role FROM users WHERE id = ?`, [userId]);
  if (user?.role === "admin" || user?.role === "viewer") {
    return all<{ id: string }>(`SELECT id FROM projects WHERE active = 1`, []).map((r) => r.id);
  }
  return all<{ project_id: string }>(`SELECT project_id FROM project_memberships WHERE user_id = ?`, [userId]).map((r) => r.project_id);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const clampInt = (v: unknown, def: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def; };

export function buildWhere(projectIds: string[], args: Record<string, unknown>) {
  const ids = projectIds.length ? projectIds : ["__none__"];
  const to = str(args.to) ?? new Date().toISOString();
  const from = str(args.from) ?? new Date(Date.now() - clampInt(args.last_days, 30, 120) * 86_400_000).toISOString();
  const parts = ["project_id IN {project_ids:Array(String)}", "timestamp >= parseDateTimeBestEffort({from:String})", "timestamp < parseDateTimeBestEffort({to:String})"];
  const params: Record<string, unknown> = { project_ids: ids, from, to };
  // optional single-project narrowing (must be within allowed set)
  const proj = str(args.project);
  if (proj && ids.includes(proj)) { parts.push("project_id = {project:String}"); params.project = proj; }
  for (const [k, col] of [["environment", "environment"], ["release", "release"], ["browser", "browser"], ["group_id", "group_id"]] as const) {
    const v = str(args[k]); if (v) { parts.push(`${col} = {${k}:String}`); params[k] = v; }
  }
  if (str(args.message_contains)) { parts.push("positionCaseInsensitiveUTF8(message, {message_contains:String}) > 0"); params.message_contains = args.message_contains; }
  if (str(args.title_contains)) { parts.push("positionCaseInsensitiveUTF8(title, {title_contains:String}) > 0"); params.title_contains = args.title_contains; }
  return { clause: parts.join(" AND "), params };
}

const commonProps = { from: { type: "string" }, to: { type: "string" }, last_days: { type: "number" }, project: { type: "string", description: "Restrict to one project id (must be one you can access)" }, environment: { type: "string" }, release: { type: "string" }, browser: { type: "string" }, message_contains: { type: "string" }, title_contains: { type: "string" } };

export const MCP_TOOLS = [
  { name: "list_projects", description: "Projects you can access (id, name, slug, environment).", inputSchema: { type: "object", properties: {} },
    handler: async (ids: string[]) => ids.length ? all(`SELECT id, name, slug, environment FROM projects WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [] },
  { name: "error_trend", description: "Daily/hourly error counts over a range; optional group_by.", inputSchema: { type: "object", properties: { ...commonProps, bucket: { type: "string", enum: ["day", "hour"] }, group_by: { type: "string", enum: ["none", "project", "release", "severity", "browser", "os", "environment"] } } },
    handler: async (ids: string[], args: Record<string, unknown>) => { const { clause, params } = buildWhere(ids, args); const bucket = args.bucket === "hour" ? "toStartOfHour(timestamp)" : "toDate(timestamp)"; const dimMap: Record<string, string | null> = { none: null, project: "project_id", release: "release", severity: "severity", browser: "browser", os: "os", environment: "environment" }; const dim = dimMap[str(args.group_by) ?? "none"] ?? null; const sel = dim ? `${dim} AS dimension, ` : ""; const grp = dim ? `, ${dim}` : ""; return q(`SELECT ${bucket} AS bucket, ${sel} count() AS events, uniq(user_id) AS users, uniq(group_id) AS groups FROM events WHERE ${clause} GROUP BY bucket${grp} ORDER BY bucket${dim ? ", events DESC" : ""}`, params); } },
  { name: "top_issues", description: "Top error groups by count with first/last seen.", inputSchema: { type: "object", properties: { ...commonProps, limit: { type: "number" } } },
    handler: async (ids: string[], args: Record<string, unknown>) => { const { clause, params } = buildWhere(ids, args); const limit = clampInt(args.limit, 25, 500); return q(`SELECT group_id, any(title) AS title, any(message) AS message, any(project_id) AS project_id, count() AS events, uniq(user_id) AS users, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE ${clause} GROUP BY group_id ORDER BY events DESC LIMIT ${limit}`, params); } },
  { name: "search_events", description: "Individual events matching filters, newest first.", inputSchema: { type: "object", properties: { ...commonProps, group_id: { type: "string" }, limit: { type: "number" } } },
    handler: async (ids: string[], args: Record<string, unknown>) => { const { clause, params } = buildWhere(ids, args); const limit = clampInt(args.limit, 50, 500); return q(`SELECT event_id, timestamp, project_id, group_id, severity, title, message, release, environment, browser, os, device, user_id, user_email FROM events WHERE ${clause} ORDER BY timestamp DESC LIMIT ${limit}`, params); } },
  { name: "get_event", description: "Full detail for one event_id + breadcrumbs (within your projects).", inputSchema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    handler: async (ids: string[], args: Record<string, unknown>) => { const id = str(args.event_id); if (!id) throw new Error("event_id required"); const list = ids.length ? ids : ["__none__"]; const ev = await q(`SELECT * FROM events WHERE event_id = {event_id:String} AND project_id IN {project_ids:Array(String)} ORDER BY timestamp DESC LIMIT 1`, { event_id: id, project_ids: list }); const bc = await q(`SELECT timestamp, category, level, type, message, data FROM breadcrumbs WHERE event_id = {event_id:String} AND project_id IN {project_ids:Array(String)} ORDER BY timestamp ASC LIMIT 200`, { event_id: id, project_ids: list }); return { event: ev[0] ?? null, breadcrumbs: bc }; } },
  { name: "project_info", description: "Summary stats over a range for your projects.", inputSchema: { type: "object", properties: { ...commonProps } },
    handler: async (ids: string[], args: Record<string, unknown>) => { const { clause, params } = buildWhere(ids, args); const rows = await q(`SELECT count() AS events, uniq(user_id) AS users, uniq(group_id) AS groups, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE ${clause}`, params); return rows[0] ?? {}; } },
] as { name: string; description: string; inputSchema: object; handler: (ids: string[], args: Record<string, unknown>) => Promise<unknown> }[];

export function getTool(name: string) { return MCP_TOOLS.find((t) => t.name === name); }
