import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idsFromIssuePath, isAddressable, issuePath, path } from "./url.ts";

const BASE = "http://localhost";

// A group id is the event's explicit fingerprint verbatim (backend/src/lib/ingest.ts:158), chosen by whoever
// holds the project's DSN. Security review of PROD-10519 closed a different real issue by clicking Close on a
// row whose id was "probe/../<real group>": the unencoded id turned the request path into
// .../errors/probe/../<real>/workflow, which the URL parser collapses to the real group's. Every id has to
// stay one path segment whatever characters it holds.
const HOSTILE_IDS = ["probe/../2f244f2d0248a5d02f2200f0495880eb", "a?b=c", "a#b", "a%2Fb", "a\\b", "a b", "../../x", "x/"];

test("an id containing /, .. or ? never changes which resource the request names", () => {
  for (const id of HOSTILE_IDS) {
    const url = new URL(path`/api/projects/${"proj"}/errors/${id}/workflow`, BASE);
    const segments = url.pathname.split("/");
    assert.deepEqual(segments.slice(0, 5), ["", "api", "projects", "proj", "errors"], id);
    assert.equal(segments.length, 7, `${id} must stay one segment`);
    assert.equal(decodeURIComponent(segments[5]), id);
    assert.equal(segments[6], "workflow");
    assert.equal(url.search, "", id);
    assert.equal(url.hash, "", id);
  }
});

// This checks URL parsing only: the route is three segments whatever the ids hold. Whether the router hands
// the ids back unchanged is a different question, answered by idsFromIssuePath below.
test("the client route for an issue holds both ids as single path segments", () => {
  for (const id of HOSTILE_IDS) {
    const href = issuePath("proj/../other", id);
    assert.ok(href);
    const segments = new URL(href, BASE).pathname.split("/");
    assert.equal(segments.length, 4);
    assert.equal(segments[1], "errors");
    assert.equal(decodeURIComponent(segments[2]), "proj/../other");
    assert.equal(decodeURIComponent(segments[3]), id);
  }
});

// React Router decodes a route param twice for a %2F (its matcher decodes the path, then each param), so an id
// holding a literal "%2F" (sent as %252F) arrived as "/" and the issue opened as "isn't available" (PROD-10519
// re-review). The detail page reads its ids from the raw pathname through this function instead, which
// decodes each segment exactly once, so the id that reaches the API is the id in the link.
test("the ids read back from an issue route equal the ids it was built from, router or not", () => {
  for (const id of [...HOSTILE_IDS, "a%2Fb", "100%", "%41", "naïve/ü"]) {
    const href = issuePath("proj/../other", id);
    assert.ok(href);
    assert.deepEqual(idsFromIssuePath(href), { projectId: "proj/../other", groupId: id }, id);
  }
  assert.deepEqual(idsFromIssuePath("/errors/p1/g1/"), { projectId: "p1", groupId: "g1" });
});

test("a pathname that is not exactly one issue route, or holds a broken escape, reads as no ids", () => {
  for (const pathname of ["/errors", "/errors/p1", "/errors/p1/g1/extra", "/settings/members", "/errors//g1", "/errors/p1/%E0%A4%A", "/errors/p1/%"]) {
    assert.equal(idsFromIssuePath(pathname), null, pathname);
  }
});

// A URL parser collapses "." and ".." path segments, and also their %2e spellings, before the request is
// sent, so no encoding can carry them: the request would name the parent resource. Fail closed. The route
// helper returns null so a row with such an id renders without a link instead of crashing the list.
test("an id that is only dots cannot be put in a path, and its route is null", () => {
  assert.throws(() => path`/api/x/${".."}`, RangeError);
  assert.throws(() => path`/api/x/${"."}`, RangeError);
  assert.equal(isAddressable(".."), false);
  assert.equal(isAddressable("..."), true);
  assert.equal(issuePath("proj", ".."), null);
  assert.equal(issuePath(".", "group"), null);
});

// The encoding is only as good as its use: one raw `${id}` in a URL template reopens the hole. api.ts is the
// only place requests are built, so its source is checked for any /api/ or /auth/ template literal that
// interpolates without going through the path tag.
test("api.ts builds every interpolated request URL through the path tag", () => {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  const offenders = [...source.matchAll(/(\bpath)?`(\/(?:api|auth)\/[^`]*)`/g)]
    .filter(([, tag, body]) => !tag && body.includes("${"))
    .map(([, , body]) => body);
  assert.deepEqual(offenders, []);
});
