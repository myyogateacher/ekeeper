import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ClickHouseError, createClient, type ClickHouseClient } from "@clickhouse/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { normalizeTimestamp, toClickHouseDateTime } from "./ingest";

// These tests run the real enqueueBufferedIngest, flushBufferedIngest and ingest routes against an in-memory Redis and
// a recording ClickHouse client, so they need no Redis or ClickHouse. They do need the app environment set, like the
// other store-backed tests here, because the real modules are loaded once to be put back (below) and they load ../config.
// ./redis, ../db/clickhouse, ../db/sqlite and ./issue-sync are replaced by factories that name every export
// ingest-buffer.ts and routes/ingest.ts import from them, because a mocked module missing a named export fails at link
// time. ./ingest is replaced only to let a test make normalizeEvent throw, see POISON_EVENT_ID.
//
// mock.module in bun replaces the module for every test file that runs after this one in the same process, and
// mock.restore() does not undo it, so afterAll puts the real modules back. They are copied before they are replaced (a
// spread: the namespace object bun hands back is rewired to the mock afterwards).
const original = {
  redis: { ...(await import("./redis")) },
  clickhouse: { ...(await import("../db/clickhouse")) },
  sqlite: { ...(await import("../db/sqlite")) },
  issueSync: { ...(await import("./issue-sync")) },
  ingest: { ...(await import("./ingest")) },
};

const BUCKET = "ekeeper:ingest-buffer:2020-01-01T00:00:00.000Z";
let buckets = new Map<string, string[]>();
let inserts: Array<{ table: string; values: Array<Record<string, unknown>> }> = [];
let failNextInsert = false;
// Set only by the opt-in live block at the bottom: the client for a scratch ClickHouse database. While it is null the
// recording fake below stands in for ClickHouse.
let liveClient: ClickHouseClient | null = null;
type InsertOptions = { table: string; values: Array<Record<string, unknown>>; format: "JSONEachRow" };
// Test-only rewrite of what the live block sends, so a test can make the real engine refuse a row that production code
// would never produce. Production code is not changed for it.
let liveRewrite: ((options: InsertOptions) => Partial<InsertOptions>) | null = null;
let insertAttempts: Array<{ table: string; size: number }> = [];
// Runs at the top of every insert on the recording fake; throw from it to make that insert fail.
let beforeInsert: ((options: InsertOptions) => void) | null = null;
let githubIntegration: object | null = null;
let issueCalls: Array<Record<string, unknown>> = [];

const fakeRedis = {
  set: async () => "OK",
  keys: async () => [...buckets.keys()],
  lRange: async (key: string) => buckets.get(key) ?? [],
  del: async (key: string) => (buckets.delete(key) ? 1 : 0),
  multi: () => {
    const chain = {
      rPush: (key: string, items: string[]) => {
        buckets.set(key, [...(buckets.get(key) ?? []), ...items]);
        return chain;
      },
      expire: () => chain,
      exec: async () => [],
    };
    return chain;
  },
};

mock.module("./redis", () => ({ connectRedis: async () => fakeRedis }));
const recordingClickHouse = {
  insert: async (options: InsertOptions) => {
    insertAttempts.push({ table: options.table, size: options.values.length });
    beforeInsert?.(options);
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error("ClickHouse unavailable");
    }
    inserts.push({ table: options.table, values: options.values });
  },
};
mock.module("../db/clickhouse", () => ({
  getClickHouseClient: () =>
    liveClient
      ? { insert: (options: InsertOptions) => liveClient!.insert({ ...options, ...liveRewrite?.(options) }) }
      : recordingClickHouse,
}));
// `one` answers two call sites: the project-key lookup in routes/ingest.ts (only "key_a" exists) and the project-name
// read before a GitHub issue is created. `run` reopens closed issues and `all` reads existing GitHub links.
mock.module("../db/sqlite", () => ({
  one: (query: string, params: unknown[]) => {
    if (query.includes("project_keys")) {
      return params[0] === "key_a" ? { projectId: "project_a", publicKey: "key_a", sentryProjectId: "1" } : null;
    }
    return { name: "Project A" };
  },
  all: () => [],
  run: () => ({ changes: 0, lastInsertRowid: 0 }),
}));
mock.module("./issue-sync", () => ({
  getGithubIntegration: () => githubIntegration,
  ensureGithubIssueForGroup: async (input: Record<string, unknown>) => {
    issueCalls.push(input);
  },
}));
// No JSON shape is known to make the fixed normalizeEvent throw (see ingest.test.ts), and one that could not be enqueued
// cannot be put in a bucket either, so the flush's per-payload catch is exercised by throwing on a marked event. It stands
// for a future normalizeEvent bug hitting an entry that an older build buffered, past the enqueue gate.
const POISON_EVENT_ID = "evt_poison";
mock.module("./ingest", () => ({
  ...original.ingest,
  normalizeEvent: (projectId: string, payload: Record<string, unknown>) => {
    if (payload.event_id === POISON_EVENT_ID) {
      throw new Error("normalizeEvent failed");
    }
    return original.ingest.normalizeEvent(projectId, payload);
  },
}));

const { flushBufferedIngest, enqueueBufferedIngest } = await import("./ingest-buffer");
const { HttpError } = await import("./http");
const { ingestRouter } = await import("../routes/ingest");

afterAll(() => {
  mock.module("./redis", () => original.redis);
  mock.module("../db/clickhouse", () => original.clickhouse);
  mock.module("../db/sqlite", () => original.sqlite);
  mock.module("./issue-sync", () => original.issueSync);
  mock.module("./ingest", () => original.ingest);
});

// Restores the console spies below. It does not undo mock.module (verified: a module stays mocked after mock.restore()).
afterEach(() => mock.restore());

beforeEach(() => {
  buckets = new Map();
  inserts = [];
  failNextInsert = false;
  insertAttempts = [];
  beforeInsert = null;
  liveRewrite = null;
  githubIntegration = null;
  issueCalls = [];
});

const goodEvent = (eventId: string) => ({
  event_id: eventId,
  message: "boom",
  breadcrumbs: [{ category: "ui.click", message: "clicked save", timestamp: "2026-11-13T00:00:00.000Z" }],
});
// The shape from the ticket: a null frame and no explicit fingerprint made normalizeEvent throw.
const nullFrameEvent = { event_id: "evt_null_frame", exception: { values: [{ type: "Error", value: "v", stacktrace: { frames: [null] } }] } };
const poisonEvent = { event_id: POISON_EVENT_ID };
const entry = (projectId: string, payload: unknown) => JSON.stringify({ projectId, payload });
const storedIds = (table: string) =>
  inserts.filter((insert) => insert.table === table).flatMap((insert) => insert.values.map((row) => String(row.event_id)));
const storedEventIds = () => storedIds("events");

describe("flushBufferedIngest", () => {
  // The ticket's shape. A null frame made normalizeEvent throw out of insertEvents before the bucket was deleted, and the
  // bucket was retried every 5 minutes: projects before the bad one were inserted again on every retry (events is a plain
  // MergeTree, nothing dedupes) and projects after it were never stored. The second flush is that retry.
  test("an event with a null stack frame between two good events is stored with them, each exactly once", async () => {
    buckets.set(BUCKET, [
      entry("project_a", goodEvent("evt_a")),
      entry("project_m", nullFrameEvent),
      entry("project_b", goodEvent("evt_b")),
    ]);

    await flushBufferedIngest();
    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_a", "evt_null_frame", "evt_b"]);
    expect(storedIds("breadcrumbs")).toEqual(["evt_a", "evt_b"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // The backstop behind normalizeEvent: whatever still throws is dropped alone. A payload that cannot be normalised
  // fails the same way on every retry, so dropping it loses nothing a retry could save.
  test("a payload that normalizeEvent throws on is dropped, and the good events around it are stored exactly once", async () => {
    buckets.set(BUCKET, [
      entry("project_a", goodEvent("evt_a")),
      entry("project_m", poisonEvent),
      entry("project_b", goodEvent("evt_b")),
    ]);

    await flushBufferedIngest();
    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_a", "evt_b"]);
    expect(storedIds("breadcrumbs")).toEqual(["evt_a", "evt_b"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // normalizeEvent used to run over the whole project batch, so one bad event also took down the good events that
  // shared its project.
  test("a payload that cannot be normalised does not take down the good events of its own project", async () => {
    buckets.set(BUCKET, [
      entry("project_a", goodEvent("evt_1")),
      entry("project_a", poisonEvent),
      entry("project_a", goodEvent("evt_2")),
    ]);

    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_1", "evt_2"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // The payload can hold user emails, so the drop is logged with the project id and the error and nothing else.
  test("the log line for a dropped payload names the project and the error, never the payload", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    buckets.set(BUCKET, [entry("project_m", { ...poisonEvent, user: { email: "private@example.com" } })]);

    await flushBufferedIngest();

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain("project_m");
    expect(logged).toContain("normalizeEvent failed");
    expect(logged).not.toContain("private@example.com");
  });

  // The GitHub issue for a new group is opened from the events that were stored, so a dropped payload cannot open one.
  test("a dropped payload opens no GitHub issue, and a stored event opens one for its group", async () => {
    githubIntegration = {};
    buckets.set(BUCKET, [entry("project_a", poisonEvent), entry("project_a", goodEvent("evt_a"))]);

    await flushBufferedIngest();

    expect(issueCalls).toHaveLength(1);
    expect(issueCalls[0]).toMatchObject({ projectId: "project_a", projectName: "Project A", title: "Error: boom" });
  });

  // A bucket whose every payload is dropped has nothing to insert, and must still be deleted rather than retried.
  test("a bucket holding only unprocessable payloads is deleted without an insert", async () => {
    buckets.set(BUCKET, [entry("project_a", poisonEvent)]);

    await flushBufferedIngest();

    expect(inserts).toEqual([]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // The bucket is deleted only after every insert returned, so a ClickHouse outage retries instead of dropping events.
  // Dropping a payload that cannot be normalised is safe because it fails the same way on every retry; a failed insert is
  // not, so it must keep the bucket.
  test("a ClickHouse failure keeps the bucket so the next flush stores the events", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    buckets.set(BUCKET, [entry("project_a", goodEvent("evt_a"))]);
    failNextInsert = true;

    await flushBufferedIngest();
    expect(buckets.has(BUCKET)).toBe(true);
    expect(storedEventIds()).toEqual([]);

    await flushBufferedIngest();
    expect(buckets.has(BUCKET)).toBe(false);
    expect(storedEventIds()).toEqual(["evt_a"]);
  });
});

// A row ClickHouse refuses must not block its bucket (PROD-10530). Two timestamp shapes and a lone surrogate were each found by
// probing the engine, so the flush no longer depends on knowing every shape: when the batch INSERT fails with a parse error
// from the server, the rows are retried in halves and only the rows the server still refuses are dropped.
describe("flushBufferedIngest when ClickHouse refuses a row", () => {
  const REFUSED = "evt_refused";
  const serverError = (type: string, code: string) => new ClickHouseError({ message: "server said no", code, type });
  // What the engine does for a bad timestamp: the whole INSERT that contains the row fails.
  const refuseBatchesContaining = (table: string, matches: (row: Record<string, unknown>) => boolean) => (options: InsertOptions) => {
    if (options.table === table && options.values.some(matches)) {
      throw serverError("CANNOT_PARSE_DATETIME", "41");
    }
  };
  const refusedEvent = { ...goodEvent(REFUSED), user: { email: "private@example.com" } };

  test("a row the server refuses is dropped alone, its project's other events are stored once, and the bucket is deleted", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    beforeInsert = refuseBatchesContaining("events", (row) => row.event_id === REFUSED);
    buckets.set(BUCKET, [
      entry("project_a", goodEvent("evt_1")),
      entry("project_a", refusedEvent),
      entry("project_a", goodEvent("evt_2")),
      entry("project_a", goodEvent("evt_3")),
    ]);

    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(storedIds("breadcrumbs")).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(buckets.has(BUCKET)).toBe(false);
    // The server's message quotes the input, which can hold user emails, so only ids and the error code and type are logged.
    const logged = JSON.stringify(errorLog.mock.calls);
    for (const expected of ["project_a", REFUSED, "41", "CANNOT_PARSE_DATETIME"]) {
      expect(logged).toContain(expected);
    }
    expect(logged).not.toContain("private@example.com");
    expect(logged).not.toContain("server said no");
  });

  test("a project whose only event is refused is dropped, and the bucket is still deleted", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    githubIntegration = {};
    buckets.set(BUCKET, [entry("project_a", refusedEvent), entry("project_b", goodEvent("evt_b"))]);
    beforeInsert = refuseBatchesContaining("events", (row) => row.event_id === REFUSED);

    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_b"]);
    expect(buckets.has(BUCKET)).toBe(false);
    expect(issueCalls).toHaveLength(1);
  });

  // Halving, not one INSERT per row: every INSERT is a MergeTree part, and ClickHouse throws TOO_MANY_PARTS past a few
  // thousand, so one bad row among thousands must not create thousands of parts.
  test("one refused row among 64 costs at most 13 inserts, not 65", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    beforeInsert = refuseBatchesContaining("events", (row) => row.event_id === "evt_40");
    buckets.set(BUCKET, Array.from({ length: 64 }, (_, index) => entry("project_a", goodEvent(`evt_${index}`))));

    await flushBufferedIngest();

    expect(storedEventIds()).toHaveLength(63);
    expect(insertAttempts.filter((attempt) => attempt.table === "events").length).toBeLessThanOrEqual(13);
  });

  test("a breadcrumb the server refuses is dropped alone and its event is kept", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    beforeInsert = refuseBatchesContaining("breadcrumbs", (row) => row.category === "refused");
    const crumbs = [
      { category: "ui.click", message: "clicked", timestamp: "2026-11-13T00:00:00.000Z" },
      { category: "refused", message: "boom", timestamp: "2026-11-13T00:00:00.000Z" },
    ];
    buckets.set(BUCKET, [entry("project_a", { event_id: "evt_1", breadcrumbs: crumbs }), entry("project_a", goodEvent("evt_2"))]);

    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_1", "evt_2"]);
    const stored = inserts.filter((insert) => insert.table === "breadcrumbs").flatMap((insert) => insert.values);
    expect(stored.map((row) => `${row.event_id}:${row.category}`)).toEqual(["evt_1:ui.click", "evt_2:ui.click"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // These are the cases the retry must NOT treat as bad data. A ClickHouseError also carries failures of the server or the
  // request (measured: UNKNOWN_TABLE, UNKNOWN_DATABASE and AUTHENTICATION_FAILED), where every row would be refused and
  // dropping them would lose the whole bucket, and a connection error is not a server answer at all. Both keep the bucket
  // with one attempt, as before.
  test.each([
    ["a missing table", serverError("UNKNOWN_TABLE", "60")],
    ["a wrong password", serverError("AUTHENTICATION_FAILED", "516")],
    ["a refused connection", new Error("connect ECONNREFUSED 127.0.0.1:8123")],
  ])("%s keeps the bucket after one attempt and drops nothing", async (_label, failure) => {
    spyOn(console, "error").mockImplementation(() => {});
    beforeInsert = () => {
      throw failure;
    };
    buckets.set(BUCKET, [entry("project_a", goodEvent("evt_1")), entry("project_a", goodEvent("evt_2"))]);

    await flushBufferedIngest();

    expect(buckets.has(BUCKET)).toBe(true);
    expect(insertAttempts).toEqual([{ table: "events", size: 2 }]);

    beforeInsert = null;
    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_1", "evt_2"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // The cost of retrying in halves, in a test so it is not forgotten: an outage that starts mid-retry keeps the bucket, and
  // the halves already inserted are inserted again by the next flush.
  test("a connection error during the retry keeps the bucket, and the halves already stored are stored again by the next flush", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const refuseRefused = refuseBatchesContaining("events", (row) => row.event_id === REFUSED);
    beforeInsert = (options) => {
      calls += 1;
      if (calls === 3) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8123");
      }
      refuseRefused(options);
    };
    buckets.set(BUCKET, [
      entry("project_a", goodEvent("evt_1")),
      entry("project_a", goodEvent("evt_2")),
      entry("project_a", refusedEvent),
      entry("project_a", goodEvent("evt_3")),
    ]);

    await flushBufferedIngest();

    // Call 1 is the whole batch (refused), call 2 stores [evt_1, evt_2], call 3 hits the outage.
    expect(storedEventIds()).toEqual(["evt_1", "evt_2"]);
    expect(buckets.has(BUCKET)).toBe(true);

    await flushBufferedIngest();

    expect(storedEventIds()).toEqual(["evt_1", "evt_2", "evt_1", "evt_2", "evt_3"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });
});

describe("enqueueBufferedIngest", () => {
  const bufferedCount = () => [...buckets.values()].reduce((total, items) => total + items.length, 0);
  // Parses and stringifies fine, so a request carrying it reaches normalizeEvent, but JSON.stringify(payload) there
  // overflows the stack (it did at 50000 levels when measured, so 100000 leaves margin): the one shape normalizeEvent still
  // cannot store.
  const unstorable = { extra: JSON.parse(`${"[".repeat(100_000)}1${"]".repeat(100_000)}`) };
  const expectRefused = (error: unknown) => {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toHaveProperty("status", 400);
  };
  const refusalOf = async (payloads: unknown[]) => {
    try {
      await enqueueBufferedIngest("project_a", payloads as Record<string, unknown>[]);
    } catch (error) {
      return error;
    }
    return null;
  };

  test("a payload that normalizeEvent cannot process is refused with a 400 and never reaches Redis", async () => {
    const error = await refusalOf([unstorable]);

    expectRefused(error);
    expect(bufferedCount()).toBe(0);
  });

  // An envelope is accepted or refused as a whole: a request with one bad item is not an SDK's own output, and a partial
  // accept would answer 200 for events that were dropped.
  test("the log line for a refused payload names the project and the error, never the payload", async () => {
    const warnLog = spyOn(console, "warn").mockImplementation(() => {});

    await refusalOf([{ ...unstorable, user: { email: "private@example.com" } }]);

    const logged = JSON.stringify(warnLog.mock.calls);
    expect(logged).toContain("project_a");
    expect(logged).toContain("RangeError");
    expect(logged).not.toContain("private@example.com");
  });

  test("one unprocessable payload in a batch keeps the good payloads out of Redis too", async () => {
    const error = await refusalOf([goodEvent("evt_a"), unstorable]);

    expectRefused(error);
    expect(bufferedCount()).toBe(0);
  });

  test.each([
    ["null", null],
    ["a number", 5],
    ["a string", "event"],
    ["an array", [goodEvent("evt_a")]],
  ])("a payload that is %s is refused with a 400, since an event is a JSON object", async (_label, payload) => {
    const error = await refusalOf([payload]);

    expectRefused(error);
    expect(bufferedCount()).toBe(0);
  });

  test("a well-formed payload is buffered once", async () => {
    expect(await refusalOf([goodEvent("evt_a")])).toBeNull();
    expect(bufferedCount()).toBe(1);
  });
});

describe("ingest routes", () => {
  const app = new Hono();
  app.route("/", ingestRouter);
  // Same mapping as the onError in src/index.ts, so a refused request reads back as its real status, not 500.
  app.onError((error, ctx) =>
    ctx.json({ message: error.message }, error instanceof HttpError ? (error.status as 400) : 500));
  const post = (path: string, body: string) => app.request(path, { method: "POST", body });
  const envelopeOf = (body: string) =>
    [JSON.stringify({ event_id: "env_1" }), JSON.stringify({ type: "event" }), body].join("\n");
  const bufferedCount = () => [...buckets.values()].reduce((total, items) => total + items.length, 0);

  test("a store payload is buffered and answered 200", async () => {
    const response = await post("/key_a/store", JSON.stringify({ event_id: "evt_1", message: "boom" }));

    expect(response.status).toBe(200);
    expect(bufferedCount()).toBe(1);
  });

  // The route read payload.event_id before the gate ran, so a null body was a TypeError and answered 500, a server fault,
  // for what is the sender's malformed request.
  test("a store body of null is refused with a 400, not a 500, and nothing is buffered", async () => {
    const response = await post("/key_a/store", "null");

    expect(response.status).toBe(400);
    expect(bufferedCount()).toBe(0);
  });

  test("an envelope item that is not a JSON object is refused with a 400 and nothing is buffered", async () => {
    const response = await post("/key_a/envelope", envelopeOf("null"));

    expect(response.status).toBe(400);
    expect(bufferedCount()).toBe(0);
  });

  test.each([
    "/key_a/store",
    "/key_a/store/",
    "/key_a/api/1/store",
    "/key_a/api/1/store/",
  ])("a store payload posted to %s is buffered", async (path) => {
    expect((await post(path, JSON.stringify({ event_id: "evt_1" }))).status).toBe(200);
    expect(bufferedCount()).toBe(1);
  });

  test.each([
    "/key_a/envelope",
    "/key_a/envelope/",
    "/key_a/api/1/envelope",
    "/key_a/api/1/envelope/",
  ])("an envelope posted to %s is buffered", async (path) => {
    expect((await post(path, envelopeOf(JSON.stringify({ event_id: "evt_1" })))).status).toBe(200);
    expect(bufferedCount()).toBe(1);
  });

  test("an unknown project key is answered 404 and nothing is buffered", async () => {
    expect((await post("/key_missing/store", JSON.stringify({ event_id: "evt_1" }))).status).toBe(404);
    expect(bufferedCount()).toBe(0);
  });

  test("a Sentry project id that does not belong to the key is answered 400 and nothing is buffered", async () => {
    expect((await post("/key_a/api/2/store", JSON.stringify({ event_id: "evt_1" }))).status).toBe(400);
    expect(bufferedCount()).toBe(0);
  });

  test("an event with an unusable user.id is accepted, since normalizeEvent now stores it", async () => {
    const response = await post("/key_a/store", JSON.stringify({ event_id: "evt_1", user: { id: { toString: 1 } } }));

    expect(response.status).toBe(200);
    expect(bufferedCount()).toBe(1);
  });
});

// Opt-in: runs the real insert against a real ClickHouse, because whether ClickHouse accepts a timestamp string is a
// property of the engine, and a recording fake would pass any string. Skipped unless EKEEPER_CLICKHOUSE_LIVE_TEST=1 and
// CLICKHOUSE_URL answers /ping, so a plain `bun test` never writes to a ClickHouse server. It creates a scratch database
// from the real migrations, writes only there, and drops it afterwards. Written against ClickHouse 24.8 (the version in
// docker-compose.sample.yml); the shape table in ingest.test.ts records what that version accepted.
async function reachableClickHouse(): Promise<boolean> {
  const url = process.env.CLICKHOUSE_URL;
  if (process.env.EKEEPER_CLICKHOUSE_LIVE_TEST !== "1" || !url) {
    return false;
  }
  try {
    return (await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const describeLive = (await reachableClickHouse()) ? describe : describe.skip;

describeLive("flushBufferedIngest against a real ClickHouse", () => {
  const scratchDatabase = `ekeeper_ingest_test_${Math.random().toString(36).slice(2, 10)}`;
  const connection = {
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
  };
  const admin = createClient(connection);

  beforeAll(async () => {
    await admin.command({ query: `CREATE DATABASE ${scratchDatabase}` });
    // The statements the app itself runs (lib/migrations.ts splits on ";" at a line end and substitutes the database).
    const directory = path.resolve(import.meta.dir, "../migrations/clickhouse");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(path.join(directory, file), "utf8").replaceAll("__CLICKHOUSE_DATABASE__", scratchDatabase);
      for (const statement of sql.split(/;\s*\n/g).map((part) => part.trim()).filter(Boolean)) {
        await admin.command({ query: statement });
      }
    }
    liveClient = createClient({ ...connection, database: scratchDatabase });
  });

  afterAll(async () => {
    await liveClient?.close();
    liveClient = null;
    await admin.command({ query: `DROP DATABASE IF EXISTS ${scratchDatabase}` });
    await admin.close();
  });

  // Each test reads whole tables, so it starts from empty ones.
  beforeEach(async () => {
    await admin.command({ query: `TRUNCATE TABLE ${scratchDatabase}.events` });
    await admin.command({ query: `TRUNCATE TABLE ${scratchDatabase}.breadcrumbs` });
  });

  const rowsOf = async (table: string) =>
    (await (await admin.query({
      query: `SELECT event_id, toUnixTimestamp64Milli(timestamp) AS ms FROM ${scratchDatabase}.${table} ORDER BY event_id`,
      format: "JSONEachRow",
    })).json()) as Array<{ event_id: string; ms: string }>;

  // The same stall as a thrown normalizeEvent, one layer down: ClickHouse refuses the whole INSERT when one row's
  // timestamp does not parse, insertEvents throws, flushBucket keeps the bucket, and the next flush inserts the projects
  // before the bad one again while the ones after it are never stored.
  test("an event with a timestamp ClickHouse cannot parse is stored with the events around it, each exactly once", async () => {
    const withTimestamp = (eventId: string, timestamp: unknown) => ({
      ...goodEvent(eventId),
      timestamp,
      breadcrumbs: [{ category: "ui.click", message: "clicked save", timestamp }],
    });
    buckets.set(BUCKET, [
      entry("project_a", withTimestamp("evt_a", "2026-11-13T10:00:00.123Z")),
      entry("project_m", withTimestamp("evt_garbage", "garbage")),
      entry("project_m", withTimestamp("evt_object", { toString: 1 })),
      entry("project_b", withTimestamp("evt_b", 1731400000.123)),
    ]);
    const receivedAfter = Date.now();

    await flushBufferedIngest();
    await flushBufferedIngest();

    const events = await rowsOf("events");
    expect(events.map((row) => row.event_id)).toEqual(["evt_a", "evt_b", "evt_garbage", "evt_object"]);
    expect((await rowsOf("breadcrumbs")).map((row) => row.event_id)).toEqual(["evt_a", "evt_b", "evt_garbage", "evt_object"]);
    expect(buckets.has(BUCKET)).toBe(false);
    // Valid timestamps keep their instant; an unparseable one is stored at the time the event was received.
    const msOf = (eventId: string) => Number(events.find((row) => row.event_id === eventId)?.ms);
    expect(msOf("evt_a")).toBe(Date.parse("2026-11-13T10:00:00.123Z"));
    expect(msOf("evt_b")).toBe(1731400000123);
    expect(Math.abs(msOf("evt_garbage") - receivedAfter)).toBeLessThan(60_000);
  });

  // The other String-column failure on the engine: ClickHouse refuses a lone high surrogate ("missing second part of
  // surrogate pair"). One event carries it in every field that becomes a column, one more reaches it through a message and a
  // device model, and one is valid text that the 2048 character cap cuts through an emoji. The columns written as
  // JSON.stringify output must be accepted as they are, because JSON.stringify escapes a lone surrogate: the last
  // assertions read them back from the engine to show it.
  test("events with a lone surrogate in any field are stored with the events around them, each exactly once", async () => {
    const lone = "a\ud800b";
    const surrogates = {
      event_id: "evt_surrogates",
      level: lone,
      release: lone,
      environment: lone,
      user: { id: lone, email: lone, username: lone },
      exception: { values: [{ type: lone, value: lone, stacktrace: { frames: [{ filename: lone, function: lone }] } }] },
      fingerprint: [lone],
      tags: { [lone]: lone },
      contexts: { browser: { name: lone }, device: { model: lone }, os: { name: lone }, runtime: { name: lone } },
      breadcrumbs: [{ category: lone, level: lone, message: lone, type: lone, data: { [lone]: lone } }],
    };
    const throughMessageAndUserAgent = {
      event_id: "evt_surr_message",
      message: lone,
      request: { headers: { "User-Agent": `Mozilla/5.0 (Linux; Android 13; SM-${lone} Build/TP1A; wv)` } },
    };
    const cutThroughAnEmoji = {
      event_id: "evt_cap",
      exception: { values: [{ type: "Error", value: `${"x".repeat(2047)}\u{1F600}yy` }] },
    };
    buckets.set(BUCKET, [
      entry("project_a", goodEvent("evt_a")),
      entry("project_m", surrogates),
      entry("project_m", throughMessageAndUserAgent),
      entry("project_m", cutThroughAnEmoji),
      entry("project_b", goodEvent("evt_b")),
    ]);

    await flushBufferedIngest();
    await flushBufferedIngest();

    expect((await rowsOf("events")).map((row) => row.event_id)).toEqual(["evt_a", "evt_b", "evt_cap", "evt_surr_message", "evt_surrogates"]);
    expect(buckets.has(BUCKET)).toBe(false);
    const stored = (await (await admin.query({
      query: `SELECT user_id, group_id, title, tags, contexts, exception, stacktrace, raw_payload FROM ${scratchDatabase}.events WHERE event_id = 'evt_surrogates'`,
      format: "JSONEachRow",
    })).json()) as Array<Record<string, string>>;
    expect(stored[0].user_id).toBe("a\ufffdb");
    expect(stored[0].group_id).toBe("a\ufffdb");
    for (const column of ["tags", "contexts", "exception", "stacktrace", "raw_payload"]) {
      expect(stored[0][column]).toContain("\\ud800");
    }
    const crumbs = (await (await admin.query({
      query: `SELECT data FROM ${scratchDatabase}.breadcrumbs WHERE event_id = 'evt_surrogates'`,
      format: "JSONEachRow",
    })).json()) as Array<{ data: string }>;
    expect(crumbs[0].data).toContain("\\ud800");
  });

  // The backstop against the engine. No shape is known any more that normalizeEvent passes and ClickHouse refuses, so one is
  // forced: the test client rewrites the timestamp of one event (and of its breadcrumbs) to "garbage" on the way to the real
  // engine, which refuses the INSERT exactly as it would for a shape nobody has found yet. Nothing in production code knows.
  test("a row the engine refuses is dropped alone, and the events around it, in its project and others, are stored once", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    liveRewrite = (options) => ({
      values: options.values.map((row) => (row.event_id === "evt_forced" ? { ...row, timestamp: "garbage" } : row)),
    });
    const withCrumb = (eventId: string) => ({
      ...goodEvent(eventId),
      breadcrumbs: [{ category: "ui.click", message: "clicked", timestamp: "2026-11-13T10:00:00.123Z" }],
    });
    buckets.set(BUCKET, [
      entry("project_a", withCrumb("evt_a")),
      entry("project_m", withCrumb("evt_forced")),
      entry("project_m", withCrumb("evt_ok")),
      entry("project_b", withCrumb("evt_b")),
    ]);

    await flushBufferedIngest();
    await flushBufferedIngest();

    expect((await rowsOf("events")).map((row) => row.event_id)).toEqual(["evt_a", "evt_b", "evt_ok"]);
    expect((await rowsOf("breadcrumbs")).map((row) => row.event_id)).toEqual(["evt_a", "evt_b", "evt_ok"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // The other half of the contract, against the real client: a ClickHouseError that is not about the data (here UNKNOWN_TABLE,
  // from the real server) must not be mistaken for a refused row, or the whole bucket would be dropped row by row.
  test("a server error that is not about the data keeps the bucket, and the next flush stores everything once", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    liveRewrite = () => ({ table: "events_that_does_not_exist" });
    buckets.set(BUCKET, [entry("project_a", goodEvent("evt_a")), entry("project_b", goodEvent("evt_b"))]);

    await flushBufferedIngest();

    expect(buckets.has(BUCKET)).toBe(true);
    expect(await rowsOf("events")).toEqual([]);

    liveRewrite = null;
    await flushBufferedIngest();

    expect((await rowsOf("events")).map((row) => row.event_id)).toEqual(["evt_a", "evt_b"]);
    expect(buckets.has(BUCKET)).toBe(false);
  });

  // The engine is the oracle for normalizeTimestamp's pattern list: a pattern that is too wide lets a string through that
  // ClickHouse refuses, which is the stall again. Every text goes through a real single-row INSERT, the same JSONEachRow
  // path as the flush. The mutants are made from valid shapes by deleting, inserting, replacing and repeating characters,
  // seeded so a failure reproduces; they land on and around the edges of each pattern.
  const NOW = "2026-11-13T12:00:00.000Z";
  let counter = 0;
  const storedMs = async (text: string): Promise<number | null> => {
    const id = `ts_${(counter += 1)}`;
    try {
      await liveClient!.insert({ table: "events", values: [{ event_id: id, project_id: "ts", group_id: "g", timestamp: text }], format: "JSONEachRow" });
    } catch {
      return null;
    }
    const rows = (await (await liveClient!.query({
      query: "SELECT toUnixTimestamp64Milli(timestamp) AS ms FROM events WHERE event_id = {id:String}",
      query_params: { id },
      format: "JSONEachRow",
    })).json()) as Array<{ ms: string }>;
    return Number(rows[0].ms);
  };

  // [input, instant ClickHouse must store for it]. The float seconds rows are the ones that must not shift.
  test.each<[string, unknown, number]>([
    ["ISO with Z and milliseconds", "2026-11-13T10:00:00.123Z", Date.parse("2026-11-13T10:00:00.123Z")],
    ["ISO with Z and microseconds", "2026-11-13T10:00:00.123456Z", Date.parse("2026-11-13T10:00:00.123Z")],
    ["ISO with no zone", "2026-11-13T10:00:00.123", Date.parse("2026-11-13T10:00:00.123Z")],
    ["a date with no time", "2026-11-13", Date.parse("2026-11-13T00:00:00Z")],
    ["float seconds as a number", 1731400000.123, 1731400000123],
    ["float seconds as a string", "1731400000.123", 1731400000123],
    ["float seconds with six decimals", "1731400000.123456", 1731400000123],
    ["integer seconds", 1731400000, 1731400000000],
    ["milliseconds", 1731400000123, 1731400000123],
    ["ISO with a positive offset", "2026-11-13T15:30:00.123+05:30", Date.parse("2026-11-13T10:00:00.123Z")],
    ["ISO with a negative offset", "2026-11-13T05:00:00-05:00", Date.parse("2026-11-13T10:00:00Z")],
    ["garbage", "garbage", Date.parse(NOW)],
    ["an object", { toString: 1 }, Date.parse(NOW)],
    ["an empty string", "", Date.parse(NOW)],
  ])("ClickHouse stores %s at the right instant", async (_label, raw, expectedMs) => {
    expect(await storedMs(toClickHouseDateTime(normalizeTimestamp(raw, NOW)))).toBe(expectedMs);
  }, 20_000);

  test("no mutation of a valid timestamp comes out as text ClickHouse refuses", async () => {
    let seed = 20261113;
    const random = (below: number) => {
      seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
      return seed % below;
    };
    const pool = "0123456789-/: .TZz+,e";
    const bases = ["2026-11-13T10:00:00.123Z", "1731400000.123", "1731400000123", "2026-11-13", "2026-11-13T15:30:00.123+05:30"];
    const mutants = bases.flatMap((base) =>
      Array.from({ length: 80 }, () => {
        const at = random(base.length);
        const char = pool[random(pool.length)];
        return [
          base.slice(0, at) + base.slice(at + 1),
          base.slice(0, at) + char + base.slice(at),
          base.slice(0, at) + char + base.slice(at + 1),
          base.slice(0, at + 1) + base.slice(at, at + 1) + base.slice(at + 1),
          base.slice(0, at),
        ][random(5)];
      }),
    );

    const refused: string[] = [];
    for (const mutant of mutants) {
      const text = normalizeTimestamp(mutant, NOW);
      if ((await storedMs(toClickHouseDateTime(text))) === null) {
        refused.push(`${JSON.stringify(mutant)} -> ${JSON.stringify(text)}`);
      }
    }
    expect(refused).toEqual([]);
  }, 120_000);
});
