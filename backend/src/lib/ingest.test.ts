import { describe, expect, test } from "bun:test";
import type { NormalizedIngestEvent } from "@ekeeper/shared";
import {
  computeGroupFingerprint,
  normalizeEvent,
  normalizeExceptionValue,
  normalizeTimestamp,
  parseEnvelope,
} from "./ingest";

describe("ingest helpers", () => {
  test("normalizeExceptionValue strips pointer addresses and sorts brace contents", () => {
    const a =
      'Error Domain=NSCocoaErrorDomain Code=640 "out of space" UserInfo={NSUnderlyingError=0x303ae6bb0 {Error Domain=NSPOSIXErrorDomain Code=28 "No space left on device"}, NSURL=file:///x/manifest.json, NSUserStringVariant=Folder}';
    const b =
      'Error Domain=NSCocoaErrorDomain Code=640 "out of space" UserInfo={NSURL=file:///x/manifest.json, NSUserStringVariant=Folder, NSUnderlyingError=0x303a575d0 {Error Domain=NSPOSIXErrorDomain Code=28 "No space left on device"}}';
    const c =
      'Error Domain=NSCocoaErrorDomain Code=640 "out of space" UserInfo={NSUserStringVariant=Folder, NSUnderlyingError=0x303af14a0 {Error Domain=NSPOSIXErrorDomain Code=28 "No space left on device"}, NSURL=file:///x/manifest.json}';

    expect(normalizeExceptionValue(a)).toBe(normalizeExceptionValue(b));
    expect(normalizeExceptionValue(b)).toBe(normalizeExceptionValue(c));
    expect(normalizeExceptionValue(a)).not.toContain("0x303ae6bb0");
  });

  test("fingerprint is stable across iOS NSError pointer/key-order variants", () => {
    const buildPayload = (value: string) => ({
      exception: {
        values: [
          { type: "Error", value, stacktrace: { frames: [{ filename: "main.m", function: "write" }] } },
        ],
      },
    });
    const variantA =
      'Failed to write file. UserInfo={NSUnderlyingError=0x303ae6bb0 {Code=28}, NSURL=file:///x, NSUserStringVariant=Folder}';
    const variantB =
      'Failed to write file. UserInfo={NSURL=file:///x, NSUserStringVariant=Folder, NSUnderlyingError=0x303a575d0 {Code=28}}';

    expect(computeGroupFingerprint(buildPayload(variantA))).toBe(
      computeGroupFingerprint(buildPayload(variantB)),
    );
  });

  test("fingerprint is stable when only stack frame line numbers differ", () => {
    const buildPayload = (lineno: number) => ({
      message: "Boom",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Boom",
            stacktrace: {
              frames: [{ filename: "main.jsbundle", function: "run", lineno, colno: 4866 }],
            },
          },
        ],
      },
    });

    expect(computeGroupFingerprint(buildPayload(12))).toBe(
      computeGroupFingerprint(buildPayload(5102)),
    );
  });

  test("fingerprint is stable across deploy-specific dynamic import URLs", () => {
    const buildPayload = (deployId: string, assetName: string) => ({
      exception: {
        values: [
          {
            type: "TypeError",
            value: `Failed to fetch dynamically imported module: https://myyogateacher.com/web-app-ssr/${deployId}/assets/${assetName}`,
            stacktrace: {
              frames: [
                {
                  filename: `https://myyogateacher.com/web-app-ssr/${deployId}/assets/index-${assetName}`,
                  function: "render",
                },
              ],
            },
          },
        ],
      },
    });

    expect(
      computeGroupFingerprint(buildPayload("507d4605-d747-479e-9d6d-dd87e574bd26", "index-4a57cbf6.js")),
    ).toBe(
      computeGroupFingerprint(buildPayload("43523cee-aae1-4305-9ec3-afdbb43affb8", "index-d4067662.js")),
    );
  });

  test("normalization removes volatile API URL identifiers", () => {
    const first =
      "Token expected but missing for URL: https://gapi.myyogateacher.com/v2/sessions/recording/6b7f08df-30c6-47fc-9280-4e4e39f6b934";
    const second =
      "Token expected but missing for URL: https://gapi.myyogateacher.com/v2/sessions/recording/7c8f08df-30c6-47fc-9280-4e4e39f6b111";

    expect(normalizeExceptionValue(first)).toBe(normalizeExceptionValue(second));
  });

  test("fingerprint is stable for same payload", () => {
    const payload = {
      message: "Boom",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Boom",
            stacktrace: {
              frames: [{ filename: "index.ts", function: "run", lineno: 12 }],
            },
          },
        ],
      },
    };

    expect(computeGroupFingerprint(payload)).toBe(computeGroupFingerprint(payload));
  });

  test("normalize event keeps breadcrumbs", () => {
    const event = normalizeEvent("project_1", {
      event_id: "evt_1",
      message: "Oops",
      breadcrumbs: [{ category: "ui.click", level: "info", message: "Clicked save" }],
    });

    expect(event.projectId).toBe("project_1");
    expect(event.breadcrumbs).toHaveLength(1);
  });

  test("normalize event captures user id, email, and username on separate fields", () => {
    const event = normalizeEvent("project_1", {
      event_id: "evt_user",
      user: { id: "user-1", email: "shubhangi@myyogateacher.com", username: "shubhangi" },
    });

    expect(event.userId).toBe("user-1");
    expect(event.userEmail).toBe("shubhangi@myyogateacher.com");
    expect(event.userUsername).toBe("shubhangi");
  });

  // Golden strings below were produced by the normalisation code before the length cap existed. They pin the
  // invariant that a value of normal length groups exactly as it did, so existing groups do not split.
  test.each([
    ["a Zoom join message with a session uuid", "Zoom Meeting-Join Stalled | stage=connecting | session=3c0b6d23-33c0-4851-bbfb-22e4889c0b1a", "Zoom Meeting-Join Stalled | stage=connecting | session=_uuid_"],
    ["an iOS NSError with pointers and nested braces", 'Error Domain=NSCocoaErrorDomain Code=640 "out of space" UserInfo={NSUnderlyingError=0x303ae6bb0 {Error Domain=NSPOSIXErrorDomain Code=28 "No space left on device"}, NSURL=file:///x/manifest.json, NSUserStringVariant=Folder}', 'Error Domain=NSCocoaErrorDomain Code=640 "out of space" UserInfo={NSURL=file:///x/manifest.json, NSUnderlyingError=0x_ {Error Domain=NSPOSIXErrorDomain Code=28 "No space left on device"}, NSUserStringVariant=Folder}'],
    ["a dynamic import failure with a deploy uuid and hashed asset", "Failed to fetch dynamically imported module: https://myyogateacher.com/web-app-ssr/507d4605-d747-479e-9d6d-dd87e574bd26/assets/index-4a57cbf6.js", "Failed to fetch dynamically imported module: https://myyogateacher.com/web-app-ssr/_uuid_/assets/index-_hash_.js"],
    ["an API URL with a recording uuid", "Token expected but missing for URL: https://gapi.myyogateacher.com/v2/sessions/recording/6b7f08df-30c6-47fc-9280-4e4e39f6b934", "Token expected but missing for URL: https://gapi.myyogateacher.com/v2/sessions/recording/_uuid_"],
  ])("a real-shaped value of normal length normalises exactly as before the cap: %s", (_label, raw, expected) => {
    expect(normalizeExceptionValue(raw)).toBe(expected);
  });

  test("the group fingerprint of a real-shaped payload is unchanged by the cap", () => {
    const payload = {
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Failed to fetch dynamically imported module: https://myyogateacher.com/web-app-ssr/507d4605-d747-479e-9d6d-dd87e574bd26/assets/index-4a57cbf6.js",
            stacktrace: {
              frames: [
                { filename: "https://myyogateacher.com/web-zoom/assets/index-DoLlnhss.js", function: "kt.withScope", lineno: 3 },
                { filename: "https://myyogateacher.com/web-zoom/assets/Zoom-D9aLBtGk.js", function: "run", lineno: 589 },
              ],
            },
          },
        ],
      },
    };

    expect(computeGroupFingerprint(payload)).toBe("63cd16705fe9a466d97c6f62907a6c73");
  });

  // The cap must not split a token that starts within MAX_TOKEN_SCAN_BACK (256) characters of it. A UUID cut in half
  // by the cap is no longer a UUID, so two events that differ only in it would hash to two groups where, before the
  // cap, they were one.
  // Each case starts the volatile token itself at character 2040, so the cap at 2048 lands inside it; the indexOf
  // assertion pins that, because a token starting after the cap would pass without exercising anything.
  const fingerprintOf = (value: string) => computeGroupFingerprint({ exception: { values: [{ type: "Error", value }] } });
  // Exactly `length` characters ending in a space, so whatever follows starts a new token.
  const padTo = (length: number) => `${"word ".repeat(Math.ceil(length / 5)).slice(0, length - 1)} `;
  const uuidA = "507d4605-d747-479e-9d6d-dd87e574bd26";
  const uuidB = "43523cee-aae1-4305-9ec3-afdbb43affb8";
  test.each([
    ["a bare UUID", "", uuidA, uuidB, " then"],
    ["a UUID inside a URL path", "https://myyogateacher.com/web-app-ssr/", uuidA, uuidB, "/assets/index.js then"],
    ["a 32 character hex path segment", "https://myyogateacher.com/files/", "a".repeat(32), "b".repeat(32), "/page then"],
  ])("two values over the cap that differ only in %s across the cap share one fingerprint", (_label, prefix, a, b, suffix) => {
    const build = (token: string) => `${padTo(2040 - prefix.length)}${prefix}${token}${suffix} ${"x".repeat(500)}`;
    expect(build(a).indexOf(a)).toBe(2040);
    expect(fingerprintOf(build(a))).toBe(fingerprintOf(build(b)));
  });

  // The other side of the boundary: a token that is complete at the cap must be kept, not dropped with the next one.
  test("a UUID that ends exactly at the cap is kept and replaced", () => {
    const value = `${padTo(2048 - uuidA.length)}${uuidA} then ${"x".repeat(500)}`;
    expect(value.indexOf(uuidA) + uuidA.length).toBe(2048);
    expect(normalizeExceptionValue(value)).toEndWith("_uuid_");
  });

  // The scan back is bounded: a short lead-in followed by a long run with no spaces (a JSON body, a long URL) keeps
  // the run, or every such error collapses into one group whose title is the lead-in alone.
  test("a short lead-in followed by a long run with no spaces keeps the run, so different bodies stay apart", () => {
    const body = (id: number) => `Unexpected response: ${JSON.stringify({ id, rows: "r".repeat(3000) })}`;
    expect(normalizeExceptionValue(body(1))).toHaveLength(2048);
    expect(fingerprintOf(body(1))).not.toBe(fingerprintOf(body(2)));
  });

  // "z", not a hex letter: LONG_HEX_SEGMENT_PATTERN would turn an all-hex value into "_hash_" and hide the length.
  test("a value with no whitespace in the first 2048 characters is cut at the cap, not emptied", () => {
    expect(normalizeExceptionValue("z".repeat(5000))).toHaveLength(2048);
  });

  // Ingest is public to anyone holding a DSN and normalizeEvent runs on the single event loop in the buffer flush.
  // Before the cap, a 40k+40k hashed-asset value took 2.4 s and 20k nested braces 1.0 s (both quadratic),
  // and the time grows with the square of the length, so one crafted event froze ingest, the UI and MCP.
  const bounded = (ms: number) => expect(ms).toBeLessThan(50);
  // The second and fourth values keep their first 2048 characters in the worst shape for the quadratic steps, so
  // they exercise the work left inside the cap, not only the cheap truncation of an all-"a" prefix.
  const adversarial = {
    "an 80k+80k hashed-asset-shaped run": "a".repeat(80_000) + "-" + "b".repeat(80_000),
    "a hashed-asset-shaped run that fills the cap, then 160k more": "a".repeat(1024) + "-" + "b".repeat(160_000),
    "80k nested braces": "{".repeat(80_000) + "}".repeat(80_000),
    "braces nested to the cap, then 160k more": "{".repeat(1024) + "}".repeat(160_000),
  };

  test.each(Object.entries(adversarial))("normalising %s takes under 50 ms", (_label, value) => {
    const started = performance.now();
    normalizeExceptionValue(value);
    bounded(performance.now() - started);
  });

  test("normalizeEvent bounds an adversarial value plus four adversarial frame filenames", () => {
    const hostile = adversarial["a hashed-asset-shaped run that fills the cap, then 160k more"];
    const started = performance.now();
    normalizeEvent("project_1", {
      exception: { values: [{ type: "Error", value: hostile, stacktrace: { frames: Array.from({ length: 4 }, () => ({ filename: hostile, function: "f" })) } }] },
    });
    bounded(performance.now() - started);
  });

  // Shape copied from a stored student-web-app event (sentry.javascript.react 8.55.2): contexts holds only
  // trace and react, so the browser, os and device columns were '' until the User-Agent fallback existed.
  // Identifiers and the user block are replaced with placeholders; nothing else is hand-made.
  const webEventPayload = () => ({
    event_id: "00000000000000000000000000000001",
    level: "error",
    platform: "javascript",
    environment: "production",
    timestamp: 1794312359.1,
    request: {
      url: "https://myyogateacher.com/zmeeting?session=00000000-0000-0000-0000-000000000000&entry=web",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      },
    },
    sdk: { name: "sentry.javascript.react", version: "8.55.2" },
    tags: { app: "web-zoom", "join.stage": "connecting" },
    user: { id: "00000000-0000-0000-0000-000000000000", username: "placeholder", role: "student" },
    contexts: { trace: { trace_id: "0".repeat(32), span_id: "0".repeat(16) }, react: { version: "18.3.1" } },
    fingerprint: ["Zoom Meeting-Join Stalled", "connecting"],
    exception: { values: [{ type: "ZoomMeetingJoinStalled", value: "stalled", mechanism: { type: "generic", handled: true } }] },
  });

  test("a web event that sends no browser, os or device contexts takes them from its User-Agent", () => {
    const event = normalizeEvent("project_web", webEventPayload());

    expect(event.browser).toBe("Chrome");
    expect(event.os).toBe("Windows");
    expect(event.device).toBeNull();
  });

  test("a context value wins over the User-Agent, field by field", () => {
    const payload = webEventPayload();
    payload.contexts = { ...payload.contexts, os: { name: "Windows 11" } } as typeof payload.contexts;

    const event = normalizeEvent("project_web", payload);

    expect(event.os).toBe("Windows 11");
    expect(event.browser).toBe("Chrome");
  });

  test("an event with no request leaves browser, os and device null", () => {
    const { request: _request, ...withoutRequest } = webEventPayload();

    const event = normalizeEvent("project_web", withoutRequest);

    expect([event.browser, event.os, event.device]).toEqual([null, null, null]);
  });

  // Every field of an event is attacker-controlled JSON, because ingest is public to anyone holding a DSN. normalizeEvent
  // used to throw on the shapes below, and a throw inside the buffer flush aborted the whole project batch and then the
  // whole bucket (PROD-10530), so each case is a value JSON.parse produces that once crashed it. The assertion is only
  // "does not throw": what the field becomes is pinned by the existing grouping tests, which must stay unchanged.
  // {"toString":1} parses fine and then makes String() fail with "No default value".
  const noToString = { toString: 1 };
  // Nested 10000 deep, JSON.parse and JSON.stringify both accept it, so it passes enqueue, but String() on it overflows
  // the stack (2000 levels pass, 5000 throw), which is how it reaches the flush.
  const nested = JSON.parse(`${"[".repeat(10_000)}1${"]".repeat(10_000)}`);
  const exceptionWith = (exception: Record<string, unknown>) => ({ exception: { values: [exception] } });
  const framesOf = (frames: unknown) => exceptionWith({ type: "Error", value: "v", stacktrace: { frames } });
  const hostileEvents: Array<[string, Record<string, unknown>]> = [
    ["a null stack frame with no explicit fingerprint", framesOf([null])],
    ["stacktrace.frames that is a string", framesOf("abc")],
    ["stacktrace.frames that is an object", framesOf({})],
    ["stacktrace.frames that is a number", framesOf(5)],
    ["a frame filename that is an object", framesOf([{ filename: noToString, function: "f" }])],
    ["a frame function that is an object", framesOf([{ filename: "a.js", function: noToString }])],
    ["an exception type that is an object", exceptionWith({ type: noToString, value: "v" })],
    ["an exception value that is an object", exceptionWith({ type: "Error", value: noToString })],
    ["a message that is an object when there is no exception", { message: noToString }],
    ["user.id that is an object", { user: { id: noToString } }],
    ["user.email that is an object", { user: { email: noToString } }],
    ["user.username that is an object", { user: { username: noToString } }],
    ["event_id that is an object", { event_id: noToString }],
    ["level that is an object", { level: noToString }],
    ["timestamp that is an object", { timestamp: noToString }],
    ["release that is an object", { release: noToString }],
    ["environment that is an object", { environment: noToString }],
    ["a tag value that is an object", { tags: { a: noToString } }],
    ["a breadcrumb category that is an object", { breadcrumbs: [{ category: noToString }] }],
    ["a breadcrumb timestamp that is an object", { breadcrumbs: [{ timestamp: noToString }] }],
    ["contexts.browser.name that is an object", { contexts: { browser: { name: noToString } } }],
    ["contexts.device.model that is an object", { contexts: { device: { model: noToString } } }],
    ["contexts.device.family that is an object", { contexts: { device: { family: noToString } } }],
    ["contexts.os.name that is an object", { contexts: { os: { name: noToString } } }],
    ["contexts.runtime.name that is an object", { contexts: { runtime: { name: noToString } } }],
    ["user.id nested deep enough to overflow String()", { user: { id: nested } }],
    ["an exception value nested deep enough to overflow String()", exceptionWith({ type: "Error", value: nested })],
  ];

  test.each(hostileEvents)("normalizeEvent does not throw on %s", (_label, payload) => {
    expect(normalizeEvent("project_1", payload).projectId).toBe("project_1");
  });

  // One unusable field costs only that field: the rest of the event is still stored and still groups.
  test("a user.id that cannot be read as text does not discard the rest of the event", () => {
    const event = normalizeEvent("project_1", {
      user: { id: noToString, email: "a@example.com" },
      exception: { values: [{ type: "TypeError", value: "boom" }] },
    });

    expect(event.userId).toBeNull();
    expect(event.userEmail).toBe("a@example.com");
    expect(event.title).toBe("TypeError: boom");
  });

  test("a null frame groups like an empty frame, so it neither throws nor splits the group", () => {
    const withFrames = (frames: unknown[]) => computeGroupFingerprint(framesOf(frames));

    expect(withFrames([{ filename: "a.js", function: "f" }, null])).toBe(
      withFrames([{ filename: "a.js", function: "f" }, {}]),
    );
  });

  // ClickHouse refuses a whole INSERT when one row's timestamp does not parse into events.timestamp DateTime64(3, 'UTC'), so
  // one event with timestamp "garbage" kept its bucket from ever being deleted (PROD-10530). The table below is what
  // ClickHouse 24.8 did with each shape in a JSONEachRow insert, measured on a real server through the app's own insert and
  // toClickHouseDateTime (T to a space, Z dropped); the live block at the end of ingest-buffer.test.ts re-checks the shapes
  // that matter, and mutations of them, against an engine. "kept" returns the input unchanged because ClickHouse already stores the right instant; "reread" is
  // the one shape ClickHouse rejects that is still a real instant (an ISO offset); "now" is a fallback to the receive time.
  const NOW = "2026-11-13T12:00:00.000Z";
  test.each<[string, unknown, string]>([
    // kept: ISO-8601 as Sentry SDKs send it, with and without milliseconds, microseconds or a zone
    ["ISO with Z and milliseconds", "2026-11-13T10:00:00.123Z", "2026-11-13T10:00:00.123Z"],
    ["ISO with Z and no fraction", "2026-11-13T10:00:00Z", "2026-11-13T10:00:00Z"],
    ["ISO with Z and microseconds", "2026-11-13T10:00:00.123456Z", "2026-11-13T10:00:00.123456Z"],
    ["ISO with no zone", "2026-11-13T10:00:00.123", "2026-11-13T10:00:00.123"],
    ["a date with no time", "2026-11-13", "2026-11-13"],
    ["a space instead of the T", "2026-11-13 10:00:00.123", "2026-11-13 10:00:00.123"],
    // kept: Unix seconds, which the Sentry JS and mobile SDKs send as a float. The instant must not move.
    ["float seconds as a number", 1731400000.123, "1731400000.123"],
    ["float seconds as a string", "1731400000.123", "1731400000.123"],
    ["float seconds with six decimals", "1731400000.123456", "1731400000.123456"],
    ["integer seconds as a number", 1731400000, "1731400000"],
    ["integer seconds as a string", "1731400000", "1731400000"],
    ["milliseconds as a number", 1731400000123, "1731400000123"],
    ["milliseconds as a string", "1731400000123", "1731400000123"],
    // kept although meaningless: ClickHouse accepts these and clamps or wraps them, and an accepted shape must keep the
    // instant it has today, so they are not rewritten
    ["a year past 2299", "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
    ["a year before 1900", "1800-01-01T00:00:00.000Z", "1800-01-01T00:00:00.000Z"],
    ["year 0000", "0000-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z"],
    ["month 13", "2026-13-45T10:00:00.000Z", "2026-13-45T10:00:00.000Z"],
    // reread: ClickHouse rejects an offset, JavaScript reads it exactly
    ["ISO with a positive offset", "2026-11-13T15:30:00.123+05:30", "2026-11-13T10:00:00.123Z"],
    ["ISO with a zero offset", "2026-11-13T10:00:00.123+00:00", "2026-11-13T10:00:00.123Z"],
    ["ISO with a negative offset and no fraction", "2026-11-13T05:00:00-05:00", "2026-11-13T10:00:00.000Z"],
    ["a space and an offset", "2026-11-13 15:30:00.123+05:30", "2026-11-13T10:00:00.123Z"],
    // now: ClickHouse rejects all of these
    ["an empty string", "", NOW],
    ["garbage", "garbage", NOW],
    ["the word null", "null", NOW],
    ["NaN", "NaN", NOW],
    ["zero", 0, NOW],
    ["an object", {}, NOW],
    ["an object with a non-callable toString", { toString: 1 }, NOW],
    ["an array", [1, 2], NOW],
    ["true", true, NOW],
    ["a number that prints with an exponent", 1e21, NOW],
    ["a lowercase z", "2026-11-13t10:00:00z", NOW],
    ["an offset without a colon", "2026-11-13T10:00:00.123+0530", NOW],
    ["a time with no seconds", "2026-11-13 10:00", NOW],
    ["a trailing space", "2026-11-13 10:00:00 ", NOW],
    ["a leading space on seconds", " 1731400000", NOW],
    ["a text date", "Fri Nov 13 2026 10:00:00 GMT+0000", NOW],
    ["an offset that is not a date", "2026-13-45T10:00:00+05:30", NOW],
    ["an offset that carries the year past 9999", "9999-12-31T23:00:00-05:00", NOW],
    // now although ClickHouse accepts them: each is stored there as a wrong date (year 2299, 1900, 1969 or 1970), so the
    // receive time is closer to the truth, and no SDK sends them
    ["microseconds as a number", 1731400000123456, NOW],
    ["a negative number", -1, NOW],
    ["a compact date as digits", "20261113", NOW],
    ["a date with slashes", "2026/11/13 10:00:00", NOW],
    ["milliseconds with a fraction", "1731400000123.5", NOW],
    // absent
    ["undefined", undefined, NOW],
    ["null", null, NOW],
  ])("normalizeTimestamp turns %s into a value ClickHouse stores correctly", (_label, raw, expected) => {
    expect(normalizeTimestamp(raw, NOW)).toBe(expected);
  });

  test("an event and its breadcrumbs with unparseable timestamps are stamped with the receive time", () => {
    const before = Date.now();
    const event = normalizeEvent("project_1", {
      timestamp: "garbage",
      breadcrumbs: [{ message: "a", timestamp: "garbage" }, { message: "b", timestamp: 1731400000.5 }, { message: "c" }],
    });

    for (const stamp of [event.timestamp, event.breadcrumbs[0].timestamp, event.breadcrumbs[2].timestamp]) {
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(stamp)).toBeLessThan(before + 60_000);
    }
    expect(event.breadcrumbs[1].timestamp).toBe("1731400000.5");
  });

  // ClickHouse refuses the whole INSERT when a String column holds a lone high surrogate (measured on 24.8: "Cannot parse
  // escape sequence: missing second part of surrogate pair"), the same stall as an unparseable timestamp. JSON.parse
  // produces one from "\ud800", and the length caps can make one out of valid text by cutting an emoji in half. Columns
  // written as JSON.stringify output are not affected, because JSON.stringify escapes a lone surrogate; the live block in
  // ingest-buffer.test.ts checks that on the engine. So the invariant is on the String columns insertEvents writes directly.
  const loneSurrogate = "a\ud800b";
  const stringColumns = (event: NormalizedIngestEvent) =>
    [
      event.eventId, event.groupId, event.fingerprint, event.title, event.message, event.severity, event.timestamp,
      event.release, event.environment, event.userId, event.userEmail, event.userUsername, event.browser, event.device,
      event.os, event.runtime,
      ...event.breadcrumbs.flatMap((crumb) => [crumb.timestamp, crumb.category, crumb.level, crumb.message, crumb.type]),
    ].filter((column): column is string => typeof column === "string");
  // 2047 characters, then an emoji (two UTF-16 units) that MAX_NORMALIZED_TEXT_LENGTH cuts between its halves.
  const emojiAtTheCap = `${"x".repeat(2047)}\u{1F600}yy`;
  // The User-Agent is cut at 512 characters, and "Android 13; " plus 499 characters puts the emoji across that cut.
  const emojiAtTheUserAgentCap = `Android 13; ${"m".repeat(499)}\u{1F600}yy`;
  test.each<[string, Record<string, unknown>]>([
    ["event_id", { event_id: loneSurrogate }],
    ["level", { level: loneSurrogate }],
    ["release", { release: loneSurrogate }],
    ["environment", { environment: loneSurrogate }],
    ["user.id", { user: { id: loneSurrogate } }],
    ["user.email", { user: { email: loneSurrogate } }],
    ["user.username", { user: { username: loneSurrogate } }],
    ["the exception type", exceptionWith({ type: loneSurrogate, value: "v" })],
    ["the exception value", exceptionWith({ type: "Error", value: loneSurrogate })],
    ["a message with no exception", { message: loneSurrogate }],
    ["an explicit fingerprint", { fingerprint: [loneSurrogate] }],
    ["contexts.browser.name", { contexts: { browser: { name: loneSurrogate } } }],
    ["contexts.device.model", { contexts: { device: { model: loneSurrogate } } }],
    ["contexts.device.family", { contexts: { device: { family: loneSurrogate } } }],
    ["contexts.os.name", { contexts: { os: { name: loneSurrogate } } }],
    ["contexts.runtime.name", { contexts: { runtime: { name: loneSurrogate } } }],
    ["a breadcrumb category", { breadcrumbs: [{ category: loneSurrogate }] }],
    ["a breadcrumb level", { breadcrumbs: [{ level: loneSurrogate }] }],
    ["a breadcrumb message", { breadcrumbs: [{ message: loneSurrogate }] }],
    ["a breadcrumb type", { breadcrumbs: [{ type: loneSurrogate }] }],
    ["a device model in the User-Agent", { request: { headers: { "User-Agent": `Mozilla/5.0 (Linux; Android 13; SM-${loneSurrogate} Build/TP1A; wv)` } } }],
    ["an emoji the User-Agent cap cuts in half", { request: { headers: { "User-Agent": emojiAtTheUserAgentCap } } }],
    ["an exception value with an emoji the length cap cuts in half", exceptionWith({ type: "Error", value: emojiAtTheCap })],
    ["a message with an emoji the length cap cuts in half", { message: emojiAtTheCap }],
  ])("a lone surrogate from %s is not written to a String column", (_label, payload) => {
    const event = normalizeEvent("project_1", payload);

    expect(stringColumns(event).filter((column) => !column.isWellFormed())).toEqual([]);
  });

  test("a lone surrogate is replaced with U+FFFD and a valid string comes back byte-identical", () => {
    const event = normalizeEvent("project_1", {
      user: { id: loneSurrogate, email: "caf\u00e9 \u{1F600}@example.com" },
    });

    expect(event.userId).toBe("a\ufffdb");
    expect(event.userEmail).toBe("caf\u00e9 \u{1F600}@example.com");
  });

  // The fingerprint hash was already computed from UTF-8 bytes, which encode a lone surrogate as U+FFFD, so cleaning the
  // text first changes no hash. An explicit fingerprint is stored as the group id itself, and an event carrying a lone
  // surrogate there was refused by ClickHouse, so no stored group can split.
  test("the group fingerprint is the same for a lone surrogate and for the U+FFFD it is replaced with", () => {
    const fingerprintOf = (value: string) => computeGroupFingerprint(exceptionWith({ type: "Error", value }));

    expect(fingerprintOf(loneSurrogate)).toBe(fingerprintOf("a\ufffdb"));
    expect(computeGroupFingerprint({ fingerprint: [loneSurrogate] })).toBe("a\ufffdb");
  });

  test("parse envelope extracts event items", () => {
    const raw = [
      JSON.stringify({ event_id: "env_1" }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ event_id: "env_1", message: "Envelope" }),
    ].join("\n");

    expect(parseEnvelope(raw)).toHaveLength(1);
  });
});
