import { describe, expect, test } from "bun:test";
import {
  computeGroupFingerprint,
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

  test("parse envelope extracts event items", () => {
    const raw = [
      JSON.stringify({ event_id: "env_1" }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ event_id: "env_1", message: "Envelope" }),
    ].join("\n");

    expect(parseEnvelope(raw)).toHaveLength(1);
  });
});
