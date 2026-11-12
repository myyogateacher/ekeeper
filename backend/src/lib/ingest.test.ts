import { describe, expect, test } from "bun:test";
import {
  computeGroupFingerprint,
  explicitGroupId,
  normalizeEvent,
  normalizeExceptionValue,
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

  test("parse envelope extracts event items", () => {
    const raw = [
      JSON.stringify({ event_id: "env_1" }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ event_id: "env_1", message: "Envelope" }),
    ].join("\n");

    expect(parseEnvelope(raw)).toHaveLength(1);
  });
});

// PROD-10529. An explicit fingerprint is the group id, chosen by whoever holds the DSN, and the id reaches URLs, a
// GitHub label and a marker line. A group id that already exists must not change (it keys issue_workflows and
// error_group_github_issues), so the first table is the real ids and the second the ones that must be hashed.
describe("explicit fingerprints as group ids", () => {
  // The 9 explicit group ids among production's 200 busiest over 30 days, read from the ekeeper top_issues tool on
  // 2026-11-13 and listed in the PROD-10537 plan. Each is a fingerprint joined with ":".
  const productionIds = [
    "Zoom Meeting-Join Stalled:connecting",
    "Zoom Meeting-Join Stalled:join",
    "Zoom Meeting-Signature Error:signature",
    "Zoom Meeting-Join Error:join",
    "booking-failed:schedule_session_v1:400:DASHBOARD_RECOMMENDED_TEACHERS",
    "booking-failed:schedule_session_v1:400:TEACHER_PROFILE",
    "booking-failed:book_multiple_group_session_v2:400:none",
    "workflow-failed:joining:join_state:401",
    "workflow-failed:onboarding:otp_send:400",
  ];
  const groupIdOf = (fingerprint: unknown) => computeGroupFingerprint({ fingerprint, exception: { values: [{ type: "Error", value: "x" }] } });
  const HASH = /^[0-9a-f]{32}$/;

  test.each(productionIds)("the production group id %p is unchanged, byte for byte", (id) => {
    expect(groupIdOf([id])).toBe(id);
  });

  test("a multi-part fingerprint is joined with a colon and kept, so the Zoom group keeps its id", () => {
    expect(groupIdOf(["Zoom Meeting-Join Stalled", "connecting"])).toBe("Zoom Meeting-Join Stalled:connecting");
    expect(groupIdOf(["booking-failed", "schedule_session_v1", "400", "TEACHER_PROFILE"])).toBe("booking-failed:schedule_session_v1:400:TEACHER_PROFILE");
  });

  // The ids frontend/src/lib/url.test.ts uses to prove a group id cannot change which resource a request names.
  const hostile = ["probe/../2f244f2d0248a5d02f2200f0495880eb", "a?b=c", "a#b", "a%2Fb", "a\\b", "../../x", "x/"];
  test.each(hostile)("the hostile id %p becomes a 32 character hash", (id) => {
    expect(groupIdOf([id])).toMatch(HASH);
  });

  test('an inner space is kept by design: "a b" stays verbatim (four production ids have one)', () => {
    expect(groupIdOf(["a b"])).toBe("a b");
  });

  const refused: Array<[string, string[]]> = [
    ["a single dot", ["."]],
    ["two dots", [".."]],
    ["a dot inside a name", ["a.b"]],
    ["the empty string", [""]],
    ["a leading space", [" a"]],
    ["a trailing space", ["a "]],
    ["a trailing space on the last part", ["a", "b "]],
    ["a tab", ["a\tb"]],
    ["a newline", ["a\nb"]],
    ["a carriage return", ["a\rb"]],
    ["non-ASCII", ["caf\u00e9"]],
    ["an emoji", ["boom \u{1F4A5}"]],
    ["a comma", ["a,b"]],
    ["a backtick", ["a`b"]],
    ["a percent sign", ["100%"]],
    ["a plus sign", ["a+b"]],
    ["201 characters", ["a".repeat(201)]],
    ["201 characters across parts", ["a".repeat(100), "b".repeat(100)]],
    ["a fingerprint marker break: a newline then a fake marker", ["x\n**Fingerprint:** `abc`"]],
  ];
  test.each(refused)("%s becomes a hash", (_name, parts) => {
    expect(explicitGroupId(parts)).toMatch(HASH);
  });

  test("200 characters is kept, 201 is hashed: the cap is on the joined id", () => {
    expect(groupIdOf(["a".repeat(200)])).toBe("a".repeat(200));
    expect(groupIdOf(["a".repeat(100), "b".repeat(99)])).toBe(`${"a".repeat(100)}:${"b".repeat(99)}`);
    expect(groupIdOf(["a".repeat(201)])).toMatch(HASH);
  });

  test("the same fingerprint always gives the same id, different fingerprints give different ids", () => {
    expect(groupIdOf(["a/b"])).toBe(groupIdOf(["a/b"]));
    expect(groupIdOf(["a/b"])).not.toBe(groupIdOf(["a/c"]));
    expect(groupIdOf(["a/b", "c"])).toBe(groupIdOf(["a/b:c"]));
  });

  test("a hashed id is not the id a computed fingerprint of the same text would get", () => {
    const text = "Error|x|";
    const computed = computeGroupFingerprint({ exception: { values: [{ type: "Error", value: "x" }] } });

    expect(groupIdOf([text])).toMatch(HASH);
    expect(groupIdOf([text])).not.toBe(computed);
  });

  test("normalizeEvent stores the same id as group_id and fingerprint, so every reader of either sees the safe one", () => {
    const event = normalizeEvent("p", { fingerprint: ["probe/../x"], exception: { values: [{ type: "Error", value: "x" }] } });

    expect(event.groupId).toMatch(HASH);
    expect(event.fingerprint).toBe(event.groupId);
  });

  test("a fingerprint that is not an array of strings is ignored as before: the group comes from the exception", () => {
    const computed = computeGroupFingerprint({ exception: { values: [{ type: "Error", value: "x" }] } });

    expect(groupIdOf("not-an-array")).toBe(computed);
    expect(groupIdOf([])).toBe(computed);
    expect(groupIdOf([1, null, {}])).toBe(computed);
    expect(groupIdOf(["ok", 1])).toBe("ok");
  });

  // Defect register 79: a regex over a field a DSN holder controls needs a bound before it runs. The length check
  // comes first, so a 2 MB fingerprint never reaches the regex.
  test("a 2 MB fingerprint costs a bounded amount of work", () => {
    const startedAt = performance.now();
    const id = groupIdOf(["a".repeat(2_000_000)]);

    expect(id).toMatch(HASH);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});
