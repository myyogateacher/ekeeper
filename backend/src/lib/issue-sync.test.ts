import { describe, expect, test } from "bun:test";
import { config } from "../config";
import { buildIssueBody } from "./issue-sync";

// The last line of the body is the link a person clicks from GitHub to reach the issue. The group id in it comes
// from an explicit fingerprint chosen by whoever holds the DSN, and ids stored before PROD-10529 can hold a space,
// "/" or "?", so it has to stay one path segment (frontend/src/lib/url.ts decodes each segment once).
describe("buildIssueBody link", () => {
  const body = (groupId: string) =>
    buildIssueBody({
      projectId: "project_1",
      projectName: "Web",
      fingerprint: groupId,
      groupId,
      firstSeen: "2026-11-13T00:00:00.000Z",
      message: "boom",
      release: null,
      exceptionType: null,
      sourceMapApplied: false,
      stackBlock: "",
    });
  const lastLine = (groupId: string) => body(groupId).split("\n").at(-1)!;
  const base = `${config.APP_URL.replace(/\/+$/, "")}/errors/project_1`;

  test("the legacy Zoom group id ends the link as one encoded segment", () => {
    const line = lastLine("Zoom Meeting-Join Stalled:connecting");

    expect(line).toBe(`View in eKeeper: ${base}/Zoom%20Meeting-Join%20Stalled%3Aconnecting`);
    expect(line.endsWith("Zoom%20Meeting-Join%20Stalled%3Aconnecting")).toBe(true);
  });

  test("a 32 character hash id is unchanged by the encoding", () => {
    expect(lastLine("2f244f2d0248a5d02f2200f0495880eb")).toBe(`View in eKeeper: ${base}/2f244f2d0248a5d02f2200f0495880eb`);
  });

  test("a stored id with a slash, question mark or hash cannot leave the segment", () => {
    const plainSegments = new URL(`${base}/plain`).pathname.split("/").length;

    for (const id of ["probe/../x", "a?b=c", "a#b", "a%2Fb", "x/"]) {
      const url = new URL(lastLine(id).replace("View in eKeeper: ", ""));
      const segments = url.pathname.split("/");

      expect([segments.length, url.search, url.hash, decodeURIComponent(segments.at(-1)!)]).toEqual([plainSegments, "", "", id]);
    }
  });
});
