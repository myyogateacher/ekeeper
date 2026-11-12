import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";

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
mock.module("../db/clickhouse", () => ({
  getClickHouseClient: () => ({
    insert: async (options: { table: string; values: Array<Record<string, unknown>> }) => {
      if (failNextInsert) {
        failNextInsert = false;
        throw new Error("ClickHouse unavailable");
      }
      inserts.push({ table: options.table, values: options.values });
    },
  }),
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
