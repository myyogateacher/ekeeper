import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { config } from "../config";
import { formatIngestAlert, planIngestAlerts, sendIngestAlerts, type PlannedAlert } from "./alerts";

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
  test("a signature alerts as new from 10 production events in one bucket, not from 9", () => {
    expect(planIngestAlerts(events(9), noReopens)).toEqual([]);
    expect(planIngestAlerts(events(10), noReopens)).toEqual([
      { kind: "new", title: TITLE, eventCount: 10, groupId: "g1", release: "1.0.0" },
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
      { kind: "new", title: TITLE, eventCount: 10, groupId: "g1", release: "1.0.2" },
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
});

describe("formatIngestAlert", () => {
  const alert: PlannedAlert = { kind: "new", title: TITLE, eventCount: 10, groupId: "g1", release: "1.0.0" };

  // Ingest is public: title and release are whatever the sender chose, and the project name is typed by an admin. In Slack
  // text `<!channel>` pings the whole channel and `<https://x|y>` plants a link, so all three must reach Slack as entities.
  test("mentions and links in the title, release and project name reach Slack as plain text", () => {
    const hostile: PlannedAlert = {
      kind: "regression",
      title: "<!channel> a & b <https://x|y>",
      release: "<!here>",
      eventCount: 1,
      groupId: "a/b?c",
    };

    const text = formatIngestAlert(hostile, "<!everyone> & Co", "project_1");

    expect(text).toContain("&lt;!channel&gt; a &amp; b &lt;https://x|y&gt;");
    expect(text).toContain("&lt;!here&gt;");
    expect(text).toContain("&lt;!everyone&gt; &amp; Co");
    // The only raw angle brackets left are the two of the link this message adds itself.
    expect(text.split("<")).toHaveLength(2);
    expect(text.split(">")).toHaveLength(2);
    // The group id is one path segment, so "/" and "?" in it cannot start another segment or a query.
    expect(text).toContain("/errors/project_1/a%2Fb%3Fc|Open in eKeeper>");
  });

  // The ingest caps do not bound the exception type or the release, both are chosen by the sender, and Slack caps the size
  // of a message's text, so neither may reach the message whole.
  test("an oversized title and release are clipped before the message is built", () => {
    const text = formatIngestAlert({ ...alert, title: `T${"x".repeat(10_000)}`, release: "r".repeat(10_000) }, "Project A", "project_1");

    expect(text.length).toBeLessThan(1000);
  });

  // A backtick in the title would close the inline code span and leave the rest of the title to be formatted as mrkdwn.
  test("a backtick in the title cannot end the code span", () => {
    const text = formatIngestAlert({ ...alert, title: "Error: reading `x` of null" }, "Project A", "project_1");

    expect(text.split("`")).toHaveLength(5);
  });

  test("the kind line tells a new error from a closed issue coming back, and the text has no dashes", () => {
    const fresh = formatIngestAlert(alert, "Project A", "project_1");
    const back = formatIngestAlert({ ...alert, kind: "regression", eventCount: 1 }, "Project A", "project_1");

    expect(fresh).toContain("New error");
    expect(fresh).toContain("10 events in one 5 minute window");
    expect(back).toContain("Closed issue is back");
    expect(back).toContain("1 event in one 5 minute window");
    expect(fresh + back).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("sendIngestAlerts", () => {
  const original = config.SLACK_ALERT_WEBHOOK_URL;
  afterEach(() => {
    config.SLACK_ALERT_WEBHOOK_URL = original;
  });

  // Alerts are opt-in. With no webhook configured the flush must not touch Slack, and it must not pay a Redis or SQL round
  // trip per project per bucket to find that out, so the check comes first. The input would otherwise alert.
  test("with no webhook configured nothing is posted", async () => {
    config.SLACK_ALERT_WEBHOOK_URL = "";
    const post = spyOn(globalThis, "fetch");

    await sendIngestAlerts("project_a", events(10), noReopens);

    expect(post).not.toHaveBeenCalled();
  });
});
