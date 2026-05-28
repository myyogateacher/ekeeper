import { config } from "../config";
import { all, one, run } from "../db/sqlite";
import {
  addLabelsToGithubIssue,
  commentOnGithubIssue,
  createGithubIssue,
  listAllGithubIssues,
  listGithubIssuesByLabel,
  setGithubIssueState,
  type GithubIssueListItem,
} from "./github";
import { normalizeExceptionValue } from "./ingest";
import { deobfuscateEvent } from "./minimaps";

const STACK_FRAMES_IN_BODY = 8;

interface RawFrame {
  filename?: unknown;
  function?: unknown;
  lineno?: unknown;
  colno?: unknown;
  in_app?: unknown;
}

function formatFrameLine(frame: RawFrame): string {
  const fn = typeof frame.function === "string" && frame.function.length > 0 ? frame.function : "<anonymous>";
  const file = typeof frame.filename === "string" && frame.filename.length > 0 ? frame.filename : "<unknown>";
  const lineno = typeof frame.lineno === "number" ? frame.lineno : Number(frame.lineno);
  const colno = typeof frame.colno === "number" ? frame.colno : Number(frame.colno);
  const loc = Number.isFinite(lineno)
    ? `:${lineno}${Number.isFinite(colno) ? `:${colno}` : ""}`
    : "";
  return `at ${fn} (${file}${loc})`;
}

function buildStackBlock(stacktrace: unknown, exception: unknown): string {
  const stack = stacktrace && typeof stacktrace === "object" ? (stacktrace as Record<string, unknown>) : null;
  let frames = stack && Array.isArray(stack.frames) ? (stack.frames as RawFrame[]) : null;
  if (!frames || frames.length === 0) {
    const exc = exception && typeof exception === "object" ? (exception as Record<string, unknown>) : null;
    const values = exc && Array.isArray(exc.values) ? (exc.values as Array<Record<string, unknown>>) : null;
    const primary = values?.[0];
    const primaryStack = primary?.stacktrace && typeof primary.stacktrace === "object"
      ? (primary.stacktrace as Record<string, unknown>)
      : null;
    frames = primaryStack && Array.isArray(primaryStack.frames) ? (primaryStack.frames as RawFrame[]) : null;
  }
  if (!frames || frames.length === 0) {
    return "";
  }
  const topFrames = frames.slice(-STACK_FRAMES_IN_BODY).reverse();
  return topFrames.map(formatFrameLine).join("\n");
}

function normalizeTitleForBucketing(title: string): string {
  const colonIndex = title.indexOf(": ");
  if (colonIndex === -1) {
    return normalizeExceptionValue(title);
  }
  const head = title.slice(0, colonIndex + 2);
  const tail = title.slice(colonIndex + 2);
  return head + normalizeExceptionValue(tail);
}

const FINGERPRINT_LABEL_PREFIX = "ek:fp:";
const FINGERPRINT_BODY_MARKER = /\*\*Fingerprint:\*\*\s+`([a-f0-9]{1,64})`/i;

function fingerprintLabel(fingerprint: string): string {
  return `${FINGERPRINT_LABEL_PREFIX}${fingerprint}`;
}

function extractFingerprint(body: string | null | undefined): string | null {
  if (!body) {
    return null;
  }
  for (const entry of body.split("\n")) {
    const match = FINGERPRINT_BODY_MARKER.exec(entry);
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
}

function pickOldest(issues: GithubIssueListItem[]): GithubIssueListItem {
  return issues
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0]!;
}

export interface GithubIntegrationRow {
  projectId: string;
  owner: string;
  repo: string;
  defaultLabels: string;
  webhookSecret: string | null;
  personalAccessToken: string | null;
}

function resolveToken(integration: GithubIntegrationRow): string | null {
  return integration.personalAccessToken?.trim() || config.GITHUB_TOKEN || null;
}

export interface GithubIssueLinkRow {
  projectId: string;
  groupId: string;
  githubIssueNumber: number;
  githubIssueUrl: string;
  githubNodeId: string | null;
}

export function getGithubIntegration(projectId: string): GithubIntegrationRow | null {
  return one<GithubIntegrationRow>(
    `SELECT project_id as projectId, owner, repo, default_labels as defaultLabels,
       webhook_secret as webhookSecret, personal_access_token as personalAccessToken
     FROM project_github_integrations WHERE project_id = ?`,
    [projectId],
  );
}

export function getGithubLink(projectId: string, groupId: string): GithubIssueLinkRow | null {
  return one<GithubIssueLinkRow>(
    `SELECT project_id as projectId, group_id as groupId,
       github_issue_number as githubIssueNumber, github_issue_url as githubIssueUrl,
       github_node_id as githubNodeId
     FROM error_group_github_issues WHERE project_id = ? AND group_id = ?`,
    [projectId, groupId],
  );
}

export function findGithubLinksByIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): GithubIssueLinkRow[] {
  return all<GithubIssueLinkRow>(
    `SELECT egi.project_id as projectId, egi.group_id as groupId,
       egi.github_issue_number as githubIssueNumber, egi.github_issue_url as githubIssueUrl,
       egi.github_node_id as githubNodeId
     FROM error_group_github_issues egi
     INNER JOIN project_github_integrations pgi ON pgi.project_id = egi.project_id
     WHERE pgi.owner = ? AND pgi.repo = ? AND egi.github_issue_number = ?`,
    [owner, repo, issueNumber],
  );
}

export function getGithubLinksForProjects(projectIds: string[]): GithubIssueLinkRow[] {
  if (projectIds.length === 0) {
    return [];
  }
  return all<GithubIssueLinkRow>(
    `SELECT project_id as projectId, group_id as groupId,
       github_issue_number as githubIssueNumber, github_issue_url as githubIssueUrl,
       github_node_id as githubNodeId
     FROM error_group_github_issues WHERE project_id IN (${projectIds.map(() => "?").join(", ")})`,
    projectIds,
  );
}

export function parseLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function buildIssueBody(input: {
  projectId: string;
  projectName: string;
  fingerprint: string;
  groupId: string;
  firstSeen: string;
  message: string | null;
  release: string | null;
  exceptionType: string | null;
  sourceMapApplied: boolean;
  stackBlock: string;
}): string {
  const ekeeperUrl = `${config.APP_URL.replace(/\/+$/, "")}/errors/${input.projectId}/${input.groupId}`;
  const lines: string[] = [
    `**Project:** ${input.projectName}`,
    `**Fingerprint:** \`${input.fingerprint}\``,
    `**First seen:** ${input.firstSeen}`,
  ];
  if (input.release) {
    lines.push(`**Release:** \`${input.release}\``);
  }
  if (input.exceptionType) {
    lines.push(`**Exception type:** \`${input.exceptionType}\``);
  }
  lines.push("", "Reported automatically by eKeeper.");

  if (input.message) {
    lines.push("", "**Message:**", "```", input.message, "```");
  }

  if (input.stackBlock) {
    const heading = input.sourceMapApplied
      ? `**Stack (top ${STACK_FRAMES_IN_BODY}, source-mapped):**`
      : `**Stack (top ${STACK_FRAMES_IN_BODY}, minified):**`;
    lines.push("", heading, "```", input.stackBlock, "```");
  }

  lines.push("", `View in eKeeper: ${ekeeperUrl}`);
  return lines.join("\n");
}

export async function ensureGithubIssueForGroup(input: {
  projectId: string;
  projectName: string;
  groupId: string;
  title: string;
  fingerprint: string;
  firstSeen: string;
  message: string | null;
  release?: string | null;
  exceptionType?: string | null;
  stacktrace?: string | Record<string, unknown> | null;
  exception?: string | Record<string, unknown> | null;
  rawPayload?: string | null;
}): Promise<GithubIssueLinkRow | null> {
  const integration = getGithubIntegration(input.projectId);
  if (!integration) {
    return null;
  }
  const token = resolveToken(integration);
  if (!token) {
    console.warn("[issue-sync] no GitHub PAT configured for project; skipping issue creation", {
      projectId: input.projectId,
    });
    return null;
  }

  const existing = getGithubLink(input.projectId, input.groupId);
  if (existing) {
    return existing;
  }

  try {
    const label = fingerprintLabel(input.fingerprint);

    const remoteMatches = await listGithubIssuesByLabel({
      token,
      owner: integration.owner,
      repo: integration.repo,
      label,
    });

    if (remoteMatches.length > 0) {
      const canonical = pickOldest(remoteMatches);
      const link = upsertGithubLink({
        projectId: input.projectId,
        groupId: input.groupId,
        issueNumber: canonical.number,
        issueUrl: canonical.html_url,
        nodeId: canonical.node_id,
      });
      console.log("[issue-sync] reused existing GitHub issue via fingerprint label", {
        projectId: input.projectId,
        groupId: input.groupId,
        issueNumber: canonical.number,
        remoteMatchCount: remoteMatches.length,
      });
      return link;
    }

    const labels = [...parseLabels(integration.defaultLabels), label];

    const deobfuscated = input.rawPayload
      ? deobfuscateEvent({
          projectId: input.projectId,
          rawPayload: input.rawPayload,
          stacktrace: input.stacktrace ?? null,
          exception: input.exception ?? {},
        })
      : null;
    const stackBlock = buildStackBlock(
      deobfuscated?.stacktrace ?? input.stacktrace ?? null,
      deobfuscated?.exception ?? input.exception ?? null,
    );

    const created = await createGithubIssue({
      token,
      owner: integration.owner,
      repo: integration.repo,
      title: input.title,
      body: buildIssueBody({
        projectId: input.projectId,
        projectName: input.projectName,
        fingerprint: input.fingerprint,
        groupId: input.groupId,
        firstSeen: input.firstSeen,
        message: input.message,
        release: input.release ?? deobfuscated?.release ?? null,
        exceptionType: input.exceptionType ?? null,
        sourceMapApplied: Boolean(deobfuscated?.applied),
        stackBlock,
      }),
      labels,
    });

    return upsertGithubLink({
      projectId: input.projectId,
      groupId: input.groupId,
      issueNumber: created.number,
      issueUrl: created.url,
      nodeId: created.nodeId,
    });
  } catch (error) {
    console.error("[issue-sync] failed to create GitHub issue", {
      projectId: input.projectId,
      groupId: input.groupId,
      error,
    });
    return null;
  }
}

function upsertGithubLink(input: {
  projectId: string;
  groupId: string;
  issueNumber: number;
  issueUrl: string;
  nodeId: string | null;
}): GithubIssueLinkRow {
  const now = new Date().toISOString();
  run(
    `INSERT INTO error_group_github_issues
       (project_id, group_id, github_issue_number, github_issue_url, github_node_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, group_id) DO UPDATE SET
       github_issue_number = excluded.github_issue_number,
       github_issue_url = excluded.github_issue_url,
       github_node_id = excluded.github_node_id,
       updated_at = excluded.updated_at`,
    [input.projectId, input.groupId, input.issueNumber, input.issueUrl, input.nodeId, now, now],
  );
  return {
    projectId: input.projectId,
    groupId: input.groupId,
    githubIssueNumber: input.issueNumber,
    githubIssueUrl: input.issueUrl,
    githubNodeId: input.nodeId,
  };
}

export interface CleanupDuplicatesResult {
  titlesScanned: number;
  duplicatesClosed: number;
  linksRepaired: number;
  labelsAdded: number;
  dryRun?: boolean;
  buckets?: CleanupBucketPreview[];
}

export interface CleanupBucketPreview {
  title: string;
  canonicalIssueNumber: number;
  canonicalIssueUrl: string;
  fingerprints: string[];
  duplicateIssueNumbers: number[];
  labelsThatWouldBeAdded: string[];
}

export async function cleanupDuplicateGithubIssues(input: {
  projectId: string;
  dryRun?: boolean;
}): Promise<CleanupDuplicatesResult> {
  const integration = getGithubIntegration(input.projectId);
  if (!integration) {
    throw new Error("GitHub integration is not configured for this project");
  }
  const token = resolveToken(integration);
  if (!token) {
    throw new Error("No GitHub PAT configured for this project");
  }

  const allIssues = await listAllGithubIssues({
    token,
    owner: integration.owner,
    repo: integration.repo,
  });

  const byTitle = new Map<string, GithubIssueListItem[]>();
  for (const issue of allIssues) {
    if (!extractFingerprint(issue.body)) {
      continue;
    }
    const key = normalizeTitleForBucketing(issue.title);
    const bucket = byTitle.get(key) ?? [];
    bucket.push(issue);
    byTitle.set(key, bucket);
  }

  let duplicatesClosed = 0;
  let linksRepaired = 0;
  let labelsAdded = 0;
  const buckets: CleanupBucketPreview[] = [];

  for (const issues of byTitle.values()) {
    const sorted = issues
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const canonical = sorted[0]!;

    const fingerprintsInBucket = new Set<string>();
    for (const issue of sorted) {
      const fp = extractFingerprint(issue.body);
      if (fp) {
        fingerprintsInBucket.add(fp);
      }
    }

    const existingLabels = new Set(
      canonical.labels.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    );
    const labelsToAdd = Array.from(fingerprintsInBucket)
      .map((fp) => fingerprintLabel(fp))
      .filter((label) => !existingLabels.has(label));

    const duplicateNumbers = sorted
      .slice(1)
      .filter((duplicate) => duplicate.state !== "closed")
      .map((duplicate) => duplicate.number);

    if (input.dryRun) {
      buckets.push({
        title: canonical.title,
        canonicalIssueNumber: canonical.number,
        canonicalIssueUrl: canonical.html_url,
        fingerprints: Array.from(fingerprintsInBucket),
        duplicateIssueNumbers: duplicateNumbers,
        labelsThatWouldBeAdded: labelsToAdd,
      });
      labelsAdded += labelsToAdd.length;
      duplicatesClosed += duplicateNumbers.length;
      for (const fp of fingerprintsInBucket) {
        const existingLink = getGithubLink(input.projectId, fp);
        if (
          !existingLink ||
          existingLink.githubIssueNumber !== canonical.number ||
          existingLink.githubIssueUrl !== canonical.html_url
        ) {
          linksRepaired += 1;
        }
      }
      continue;
    }

    if (labelsToAdd.length > 0) {
      await addLabelsToGithubIssue({
        token,
        owner: integration.owner,
        repo: integration.repo,
        issueNumber: canonical.number,
        labels: labelsToAdd,
      });
      labelsAdded += labelsToAdd.length;
    }

    for (const fp of fingerprintsInBucket) {
      const existingLink = getGithubLink(input.projectId, fp);
      if (
        !existingLink ||
        existingLink.githubIssueNumber !== canonical.number ||
        existingLink.githubIssueUrl !== canonical.html_url
      ) {
        upsertGithubLink({
          projectId: input.projectId,
          groupId: fp,
          issueNumber: canonical.number,
          issueUrl: canonical.html_url,
          nodeId: canonical.node_id,
        });
        linksRepaired += 1;
      }
    }

    for (const duplicate of sorted.slice(1)) {
      if (duplicate.state !== "closed") {
        await commentOnGithubIssue({
          token,
          owner: integration.owner,
          repo: integration.repo,
          issueNumber: duplicate.number,
          body: `Duplicate of #${canonical.number}. Closed by eKeeper cleanup.`,
        });
        await setGithubIssueState({
          token,
          owner: integration.owner,
          repo: integration.repo,
          issueNumber: duplicate.number,
          state: "closed",
          stateReason: "not_planned",
        });
        duplicatesClosed += 1;
      }
    }
  }

  const result: CleanupDuplicatesResult = {
    titlesScanned: byTitle.size,
    duplicatesClosed,
    linksRepaired,
    labelsAdded,
  };
  if (input.dryRun) {
    result.dryRun = true;
    result.buckets = buckets;
  }
  return result;
}

export async function syncGithubIssueState(input: {
  projectId: string;
  groupId: string;
  ekeeperState: "open" | "closed" | "reopened";
}): Promise<void> {
  const integration = getGithubIntegration(input.projectId);
  if (!integration) {
    return;
  }
  const link = getGithubLink(input.projectId, input.groupId);
  if (!link) {
    return;
  }
  const token = resolveToken(integration);
  if (!token) {
    return;
  }

  const githubState = input.ekeeperState === "closed" ? "closed" : "open";
  const stateReason =
    input.ekeeperState === "closed"
      ? "completed"
      : input.ekeeperState === "reopened"
        ? "reopened"
        : undefined;

  try {
    await setGithubIssueState({
      token,
      owner: integration.owner,
      repo: integration.repo,
      issueNumber: link.githubIssueNumber,
      state: githubState,
      stateReason,
    });
  } catch (error) {
    console.error("[issue-sync] failed to update GitHub issue state", {
      projectId: input.projectId,
      groupId: input.groupId,
      issueNumber: link.githubIssueNumber,
      error,
    });
  }
}
