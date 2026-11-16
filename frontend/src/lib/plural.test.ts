import { test } from "node:test";
import assert from "node:assert/strict";
import { pluralize } from "./plural.ts";

// "1 issues" shipped on the Closed view header (PROD-10519 QA). Zero reads plural in English ("0 issues"), so
// the only singular count is exactly one.
test("exactly one is singular; zero and every other count are plural", () => {
  assert.equal(pluralize(1, "issue"), "issue");
  assert.equal(pluralize(0, "issue"), "issues");
  assert.equal(pluralize(2, "event"), "events");
  assert.equal(pluralize(1_204, "file"), "files");
});

// "1 needs triage" but "2 need triage": a verb agrees with the count, so a caller passes both forms.
test("a custom plural form is used for every count except one", () => {
  assert.equal(pluralize(1, "needs", "need"), "needs");
  assert.equal(pluralize(0, "needs", "need"), "need");
  assert.equal(pluralize(2, "needs", "need"), "need");
});
