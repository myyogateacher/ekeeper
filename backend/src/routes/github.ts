import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { one } from "../db/sqlite";
import { HttpError } from "../lib/http";
import { findGithubLinksByIssue } from "../lib/issue-sync";
import { upsertIssueWorkflow } from "../lib/issue-workflow";
import type { IssueState } from "@ekeeper/shared";

interface IssuesWebhookPayload {
  action?: string;
  issue?: {
    number: number;
    state: "open" | "closed";
    state_reason?: string | null;
  };
  repository?: {
    name: string;
    owner: { login: string };
    full_name: string;
  };
}

function verifySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function actionToState(action: string | undefined): IssueState | null {
  switch (action) {
    case "closed":
      return "closed";
    case "reopened":
      return "reopened";
    default:
      return null;
  }
}

export const githubRouter = new Hono();

githubRouter.post("/webhook", async (ctx) => {
  const event = ctx.req.header("x-github-event");
  if (event !== "issues") {
    return ctx.json({ ignored: true, reason: "unsupported event" });
  }

  const rawBody = await ctx.req.text();
  const payload = JSON.parse(rawBody) as IssuesWebhookPayload;
  const issue = payload.issue;
  const repository = payload.repository;
  if (!issue || !repository) {
    throw new HttpError(400, "Missing issue or repository payload");
  }

  const integration = one<{ projectId: string; webhookSecret: string | null }>(
    `SELECT project_id as projectId, webhook_secret as webhookSecret
     FROM project_github_integrations WHERE owner = ? AND repo = ?`,
    [repository.owner.login, repository.name],
  );
  if (!integration?.webhookSecret) {
    throw new HttpError(401, "Invalid webhook signature");
  }

  const signature = ctx.req.header("x-hub-signature-256") ?? null;
  if (!verifySignature(rawBody, signature, integration.webhookSecret)) {
    throw new HttpError(401, "Invalid webhook signature");
  }

  const links = findGithubLinksByIssue(repository.owner.login, repository.name, issue.number);
  if (links.length === 0) {
    return ctx.json({ ignored: true, reason: "no linked group" });
  }

  const nextState = actionToState(payload.action);
  if (!nextState) {
    return ctx.json({ ignored: true, reason: "unsupported action" });
  }

  for (const link of links) {
    upsertIssueWorkflow(link.projectId, link.groupId, { state: nextState });
  }

  return ctx.json({
    ok: true,
    state: nextState,
    updatedGroups: links.map((link) => ({ projectId: link.projectId, groupId: link.groupId })),
  });
});
