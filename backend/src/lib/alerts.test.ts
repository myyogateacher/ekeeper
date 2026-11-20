import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { config } from "../config";
import { formatIngestAlerts, planIngestAlerts, queueIngestAlerts, type PlannedAlert } from "./alerts";
import { errorGroupUrl } from "./server-settings";

// The planner and the formatter are pure, so these tests pass events and read alerts back with no Redis, SQLite or Slack.
// The titles are the normalised `${type}: ${value}` that normalizeEvent stores in event.title, which is what the planner
// groups by.
const TITLE = "TypeError: Cannot read properties of null (reading 'x')";
const event = (overrides: Partial<Parameters<typeof planIngestAlerts>[0][number]> = {}) => ({
  groupId: "g1",
  title: TITLE,
  release: "1.0.0",
  environment: "production",
  ...overrides,
});
const events = (count: number, overrides: Parameters<typeof event>[0] = {}) =>
  Array.from({ length: count }, () => event(overrides));
const noReopens = new Set<string>();

afterEach(() => mock.restore());

describe("planIngestAlerts", () => {
  // The threshold is pinned to the literal 10, not the exported constant, so changing the constant fails here and the
  // reasoning for the number (alerts.ts) has to be revisited with it.
  test("a signature alerts as a burst from 10 production events in one bucket, not from 9", () => {
    expect(planIngestAlerts(events(9), noReopens)).toEqual([]);
    expect(planIngestAlerts(events(10), noReopens)).toEqual([
      { kind: "burst", title: TITLE, eventCount: 10, groupId: "g1", release: "1.0.0" },
    ]);
  });

  // Group ids hash the last 4 stack frames, so one bug arrives under a new group id each time a minified frame name changes
  // between releases. Counting per group id would never reach 10 here (4, 3 and 3 events); counting per title does.
  test("one bug spread over several group ids is one alert, linking the first group and naming the last release", () => {
    const spread = [
      ...events(4, { groupId: "g1", release: "1.0.0" }),
      ...events(3, { groupId: "g2", release: "1.0.1" }),
      ...events(3, { groupId: "g3", release: "1.0.2" }),
    ];

    expect(planIngestAlerts(spread, noReopens)).toEqual([
      { kind: "burst", title: TITLE, eventCount: 10, groupId: "g1", release: "1.0.2" },
    ]);
  });

  // Production projects receive events tagged staging from testenv builds, and that traffic must not page anyone: the
  // filter is on the event's own environment, so 9 production events stay below the threshold however many staging ones
  // arrive beside them.
  test("staging events never count toward an alert", () => {
    expect(planIngestAlerts(events(10, { environment: "staging" }), noReopens)).toEqual([]);
    expect(planIngestAlerts([...events(9), ...events(5, { environment: "staging" })], noReopens)).toEqual([]);
  });

  // A person closed the issue as fixed, so one event of it coming back is the signal, whatever the count.
  test("a reopened group alerts as a regression on one production event, linking the reopened group", () => {
    const mixed = [event({ groupId: "g_other" }), event({ groupId: "g_closed" })];

    expect(planIngestAlerts(mixed, new Set(["g_closed"]))).toEqual([
      { kind: "regression", title: TITLE, eventCount: 2, groupId: "g_closed", release: "1.0.0" },
    ]);
  });

  test("a signature of another title does not borrow a regression", () => {
    const mixed = [event({ title: "Error: other", groupId: "g_other" }), event({ groupId: "g_closed" })];

    expect(planIngestAlerts(mixed, new Set(["g_closed"])).map((alert) => alert.title)).toEqual([TITLE]);
  });

  // The message lists at most 10 titles (alerts.ts), so the order decides which ones a flood cannot push out: regressions
  // first, then the biggest bursts.
  test("alerts come out regressions first, then bursts by event count, largest first", () => {
    const mixed = [
      ...events(10, { title: "Error: ten", groupId: "g10" }),
      ...events(12, { title: "Error: twelve", groupId: "g12" }),
      event({ title: "Error: closed", groupId: "g_closed" }),
      ...events(11, { title: "Error: eleven", groupId: "g11" }),
    ];

    expect(planIngestAlerts(mixed, new Set(["g_closed"])).map((alert) => alert.title)).toEqual([
      "Error: closed",
      "Error: twelve",
      "Error: eleven",
      "Error: ten",
    ]);
  });
});

describe("formatIngestAlerts", () => {
  const burst: PlannedAlert = { kind: "burst", title: TITLE, eventCount: 23, groupId: "g1", release: "1.0.0" };
  const regression: PlannedAlert = { kind: "regression", title: "Error: other", eventCount: 1, groupId: "g2", release: "2.0.0" };

  // The message is the contract with the channel, so its whole shape is pinned: a header naming the project, one bullet per
  // alert with the kind, the count, the title and release in code spans and the link, and a closing line for the titles that
  // did not fit.
  test("the message is a header, one bullet per alert, and a line for the titles left out", () => {
    const text = formatIngestAlerts([regression, burst], 2, "Project A", "project_1");

    expect(text).toBe(
      [
        "*Project A*, one 5 minute window",
        `• *Closed issue is back*, 1 event: \`Error: other\` release \`2.0.0\` <${errorGroupUrl("project_1", "g2")}|Open in eKeeper>`,
        `• *Error burst*, 23 events: \`${TITLE}\` release \`1.0.0\` <${errorGroupUrl("project_1", "g1")}|Open in eKeeper>`,
        "+2 more error titles over the threshold in this window",
      ].join("\n"),
    );
  });

  test("an alert without a release has no release text, and no titles left out means no closing line", () => {
    const text = formatIngestAlerts([{ ...burst, release: null }], 0, "Project A", "project_1");

    expect(text).toBe(
      `*Project A*, one 5 minute window\n• *Error burst*, 23 events: \`${TITLE}\` <${errorGroupUrl("project_1", "g1")}|Open in eKeeper>`,
    );
  });

  test("a single title left out reads as singular", () => {
    expect(formatIngestAlerts([burst], 1, "Project A", "project_1")).toContain("+1 more error title over the threshold");
  });

  // "burst" in the code only means "never alerted before": the first time an old error bursts after this ships, the message
  // must not claim the error is new. No other text may say it either.
  test("no text claims an error is new", () => {
    const text = formatIngestAlerts([burst, regression], 3, "Project A", "project_1");

    expect(text.toLowerCase()).not.toMatch(/\bnew\b/);
  });

  // Ingest is public: title and release are whatever the sender chose, and the project name is typed by an admin. In Slack
  // text `<!channel>` pings the whole channel and `<https://x|y>` renders as a link, so all three must reach Slack as entities.
  test("mentions and links in the title, release and project name reach Slack as plain text", () => {
    const hostile: PlannedAlert = {
      kind: "regression",
      title: "<!channel> a & b <https://x|y>",
      release: "<!here>",
      eventCount: 1,
      groupId: "a/b?c",
    };

    const text = formatIngestAlerts([hostile], 0, "<!everyone> & Co", "project_1");

    expect(text).toContain("&lt;!channel&gt; a &amp; b &lt;https://x|y&gt;");
    expect(text).toContain("&lt;!here&gt;");
    expect(text).toContain("&lt;!everyone&gt; &amp; Co");
    // The only raw angle brackets left are the two of the link this message adds itself.
    expect(text.split("<")).toHaveLength(2);
    expect(text.split(">")).toHaveLength(2);
    // The group id is one path segment, so "/" and "?" in it cannot start another segment or a query.
    expect(text).toContain("/errors/project_1/a%2Fb%3Fc|Open in eKeeper>");
  });

  // The ingest caps do not bound the exception type or the release, and Slack refuses an oversized message, which would fail
  // the post on every flush and, with the keys released, retry it forever.
  test("an oversized title and release are clipped before the message is built", () => {
    const text = formatIngestAlerts(
      [{ ...burst, title: `T${"x".repeat(10_000)}`, release: "r".repeat(10_000) }],
      0,
      "Project A",
      "project_1",
    );

    expect(text.length).toBeLessThan(1000);
  });

  // A backtick in the title would close the inline code span and leave the rest of the title to be formatted as mrkdwn.
  test("a backtick in the title cannot end the code span", () => {
    const text = formatIngestAlerts([{ ...burst, title: "Error: reading `x` of null" }], 0, "Project A", "project_1");

    expect(text.split("`")).toHaveLength(5);
  });

  // The exception type is neither normalised nor capped and the release is stored verbatim, so a sender can put a line break
  // in either. Slack ends an inline code span at the end of the line, and what follows is formatted as mrkdwn (bold, an
  // auto-linked bare URL), so the break must not reach Slack.
  test("a line break in the title or release cannot end the code span", () => {
    const text = formatIngestAlerts(
      [{ ...burst, title: "Error: first\n*bold* https://evil.example", release: "1.0\r\nsecond" }],
      0,
      "Project A",
      "project_1",
    );

    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("`Error: first *bold* https://evil.example`");
    expect(text).toContain("release `1.0 second`");
  });

  test("the text has no em or en dashes", () => {
    const text = formatIngestAlerts([burst, regression], 2, "Project A", "project_1");

    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("queueIngestAlerts", () => {
  const original = config.SLACK_ALERT_WEBHOOK_URL;
  afterEach(() => {
    config.SLACK_ALERT_WEBHOOK_URL = original;
  });

  // Alerts are opt-in. With no webhook configured the flush must not touch Slack, and it must not pay a Redis or SQL round
  // trip per project per bucket to find that out, so the check comes first. The input would otherwise alert.
  test("with no webhook configured nothing is posted", async () => {
    config.SLACK_ALERT_WEBHOOK_URL = "";
    const post = spyOn(globalThis, "fetch");

    queueIngestAlerts("project_a", events(10), noReopens);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(post).not.toHaveBeenCalled();
  });
});
