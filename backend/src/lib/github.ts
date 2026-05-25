import { config } from "../config";

export interface GithubIssueRef {
  number: number;
  url: string;
  nodeId: string;
  state: "open" | "closed";
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ekeeper-issue-sync",
  };
}

async function githubFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `${config.GITHUB_API_URL.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}

export async function createGithubIssue(input: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<GithubIssueRef> {
  const response = await githubFetch(input.token, "POST", `/repos/${input.owner}/${input.repo}/issues`, {
    title: input.title,
    body: input.body,
    labels: input.labels,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub create issue failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    number: number;
    html_url: string;
    node_id: string;
    state: "open" | "closed";
  };

  return {
    number: json.number,
    url: json.html_url,
    nodeId: json.node_id,
    state: json.state,
  };
}

export async function setGithubIssueState(input: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  state: "open" | "closed";
  stateReason?: "completed" | "reopened" | "not_planned";
}): Promise<void> {
  const response = await githubFetch(
    input.token,
    "PATCH",
    `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
    {
      state: input.state,
      ...(input.stateReason ? { state_reason: input.stateReason } : {}),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub update issue failed (${response.status}): ${text}`);
  }
}

export interface GithubIssueListItem {
  number: number;
  html_url: string;
  node_id: string;
  state: "open" | "closed";
  body: string | null;
  created_at: string;
  labels: Array<{ name: string } | string>;
}

export async function listGithubIssuesByLabel(input: {
  token: string;
  owner: string;
  repo: string;
  label: string;
}): Promise<GithubIssueListItem[]> {
  const path = `/repos/${input.owner}/${input.repo}/issues?state=all&per_page=100&labels=${encodeURIComponent(input.label)}`;
  const response = await githubFetch(input.token, "GET", path);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub list issues by label failed (${response.status}): ${text}`);
  }
  return (await response.json()) as GithubIssueListItem[];
}

export async function listAllGithubIssues(input: {
  token: string;
  owner: string;
  repo: string;
}): Promise<GithubIssueListItem[]> {
  const collected: GithubIssueListItem[] = [];
  let page = 1;
  while (true) {
    const path = `/repos/${input.owner}/${input.repo}/issues?state=all&per_page=100&page=${page}`;
    const response = await githubFetch(input.token, "GET", path);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub list issues failed (${response.status}): ${text}`);
    }
    const batch = (await response.json()) as Array<GithubIssueListItem & { pull_request?: unknown }>;
    const issuesOnly = batch.filter((entry) => !entry.pull_request);
    collected.push(...issuesOnly);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }
  return collected;
}

export async function addLabelsToGithubIssue(input: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  labels: string[];
}): Promise<void> {
  if (input.labels.length === 0) {
    return;
  }
  const response = await githubFetch(
    input.token,
    "POST",
    `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/labels`,
    { labels: input.labels },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub add labels failed (${response.status}): ${text}`);
  }
}

export async function commentOnGithubIssue(input: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const response = await githubFetch(
    input.token,
    "POST",
    `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
    { body: input.body },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub comment failed (${response.status}): ${text}`);
  }
}
