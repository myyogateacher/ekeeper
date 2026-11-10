# Tag filter and tags in MCP results

MCP `search_events`, `top_issues`, `error_trend` and `project_info` accept
`tag: "key:value"`, for example `app:web_home`.

## How it works

1. Tags are stored as one JSON object in the ClickHouse `events.tags` String
   column (`backend/src/lib/ingest-buffer.ts`, `insertEvents`).
2. `buildWhere` (`backend/src/lib/mcp-tools.ts`) adds
   `JSONExtractString(tags, {tag_key:String}) = {tag_value:String}`. Key and
   value are query parameters, never part of the SQL text.
3. `search_events` also returns `tags`, as the stored JSON string.

## Operational notes

- The filter splits on the first colon, so values may contain colons and keys
  may not.
- A filter with no colon, an empty key or an empty value is rejected with an
  error. Ignoring it would return every event, and an empty value would match
  every event that lacks the key.
- Exact match on key and value. No prefix, no case folding, no several tags.
- There is no index on tags: the filter parses the JSON of each event that
  passes the project and time predicates. The range is capped at 120 days.
- The REST error list (`queryErrorGroups` in `backend/src/routes/api.ts`) has
  its own query and does not support the filter.
- `get_event` returns symbolicated frames through the same `deobfuscateEvent`
  the UI detail route uses; events without a release or without an uploaded
  source map return their stored frames.

## Tests

`backend/src/lib/mcp-tools-clickhouse.test.ts` runs the real handlers on a real
ClickHouse (needs `CLICKHOUSE_URL` reachable). It writes nothing to ClickHouse:
each query shadows `events` and `breadcrumbs` with inline rows. It does write one
project row and one minimap row to the configured SQLite and one source map file
under `MINIMAPS_STORAGE_PATH`, which `afterAll` removes.
