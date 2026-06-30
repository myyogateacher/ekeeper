import { existsSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";
import { config } from "./config";
import { sessionMiddleware } from "./lib/auth";
import { HttpError } from "./lib/http";
import { startBufferedIngestFlusher } from "./lib/ingest-buffer";
import { runMigrations } from "./lib/migrations";
import { connectRedis } from "./lib/redis";
import { getServerAuthToken } from "./lib/server-settings";
import { apiRouter } from "./routes/api";
import { authRouter } from "./routes/auth";
import { githubRouter } from "./routes/github";
import { ingestRouter } from "./routes/ingest";
import { pluginRouter } from "./routes/plugin";
import { oauthRouter, protectedResourceMetadata } from "./routes/oauth";

declare module "hono" {
  interface ContextVariableMap {
    auth: import("./types/api").AuthedContext;
  }
}

const app = new Hono();
app.use("*", prettyJSON());
app.use("*", sessionMiddleware);
app.use("/api/ingest/*", cors({
  origin: (origin) => {
    if (!origin) {
      return "*";
    }

    if (config.ingestAllowedOrigins.includes("*")) {
      return origin;
    }

    return config.ingestAllowedOrigins.includes(origin) ? origin : "";
  },
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Sentry-Auth", "Authorization"],
  maxAge: 86400,
  credentials: false,
}));

app.onError((error, ctx) => {
  if (error instanceof HttpError) {
    ctx.status(error.status as 400 | 401 | 403 | 404 | 500);
    return ctx.json({ message: error.message });
  }

  console.error(error);
  ctx.status(500);
  return ctx.json({ message: "Internal server error" });
});

app.get("/.well-known/oauth-protected-resource", (ctx) =>
  ctx.json(protectedResourceMetadata(config.APP_URL)));
app.route("/", oauthRouter); // serves /.well-known/oauth-authorization-server + /oauth/*

app.route("/auth", authRouter);
app.route("/api", apiRouter);
app.route("/api/github", githubRouter);
app.route("/api/ingest", ingestRouter);
app.route("/api/0", pluginRouter);

const frontendDist = path.resolve(import.meta.dir, "../../frontend/dist");
const hasFrontendBuild = existsSync(frontendDist);

if (hasFrontendBuild) {
  app.use("/*", serveStatic({ root: frontendDist }));
  app.get("*", async (ctx) => ctx.html(await Bun.file(path.join(frontendDist, "index.html")).text()));
} else {
  app.get("/", (ctx) =>
    ctx.json({
      message: "Frontend build not found. Run `bun run --cwd frontend build` for production asset serving.",
    }),
  );
}

await runMigrations();
await connectRedis();
startBufferedIngestFlusher();
getServerAuthToken();

export default {
  port: config.BACKEND_PORT,
  fetch: app.fetch,
};

console.log(`eKeeper backend listening on ${config.APP_URL}`);
