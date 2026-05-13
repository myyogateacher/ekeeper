import { config } from "../config";
import { all, one, run } from "../db/sqlite";
import { createGithubIssue, setGithubIssueState } from "./github";

export interface GithubIntegrationRow {
  projectId: string;
  owner: string;
  repo: string;
  defaultLabels: string;
  webhookSecret: string | null;
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
    `SELECT project_id as projectId, owner, repo, default_labels as defaultLabels, webhook_secret as webhookSecret
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

export function findGithubLinkByIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): GithubIssueLinkRow | null {
  return one<GithubIssueLinkRow>(
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
}): string {
  const ekeeperUrl = `${config.APP_URL.replace(/\/+$/, "")}/errors/${input.projectId}/${input.groupId}`;
  const lines: string[] = [
    `**Project:** ${input.projectName}`,
    `**Fingerprint:** \`${input.fingerprint}\``,
    `**First seen:** ${input.firstSeen}`,
    "",
    "Reported automatically by eKeeper.",
  ];

  if (input.message) {
    lines.push("", "```", input.message, "```");
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
}): Promise<GithubIssueLinkRow | null> {
  const integration = getGithubIntegration(input.projectId);
  if (!integration) {
    return null;
  }
  if (!config.GITHUB_TOKEN) {
    console.warn("[issue-sync] GITHUB_TOKEN not configured; skipping GitHub issue creation");
    return null;
  }

  const existing = getGithubLink(input.projectId, input.groupId);
  if (existing) {
    return existing;
  }

  try {
    const created = await createGithubIssue({
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
      }),
      labels: parseLabels(integration.defaultLabels),
    });

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
      [
        input.projectId,
        input.groupId,
        created.number,
        created.url,
        created.nodeId,
        now,
        now,
      ],
    );

    return {
      projectId: input.projectId,
      groupId: input.groupId,
      githubIssueNumber: created.number,
      githubIssueUrl: created.url,
      githubNodeId: created.nodeId,
    };
  } catch (error) {
    console.error("[issue-sync] failed to create GitHub issue", {
      projectId: input.projectId,
      groupId: input.groupId,
      error,
    });
    return null;
  }
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
  if (!config.GITHUB_TOKEN) {
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
