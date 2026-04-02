import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { config } from "../config";
import { clearSession, createGoogleAuthUrl, createSession, handleGoogleCallback, requireAuth } from "../lib/auth";
import { HttpError } from "../lib/http";

export const authRouter = new Hono();

authRouter.post("/google/start", async (ctx) => {
  const url = await createGoogleAuthUrl(ctx);
  return ctx.json({ url });
});

authRouter.get("/google/callback", async (ctx) => {
  const code = ctx.req.query("code");
  const state = ctx.req.query("state");
  const storedState = getCookie(ctx, "oauth_state");

  if (!code || !state || !storedState || state !== storedState) {
    throw new HttpError(400, "Invalid Google auth state");
  }

  const user = await handleGoogleCallback(code, state);
  await createSession(ctx, user.id);
  return ctx.redirect(`${config.FRONTEND_URL}/dashboard`);
});

authRouter.post("/logout", async (ctx) => {
  requireAuth(ctx);
  await clearSession(ctx);
  return ctx.json({ success: true });
});
