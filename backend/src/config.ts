import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  BACKEND_PORT: z.coerce.number().default(3000),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().url(),
  GOOGLE_ALLOWED_DOMAINS: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("ekeeper_session"),
  SESSION_SECRET: z.string().min(1),
  SESSION_TTL_HOURS: z.coerce.number().default(168),
  REDIS_HOST: z.string().min(1).default("localhost"),
  REDIS_PORT: z.coerce.number().default(16379),
  REDIS_PASSWORD: z.string().default(""),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  SQLITE_PATH: z.string().min(1),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_HOST: z.string().min(1),
  CLICKHOUSE_PORT: z.coerce.number().default(8123),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DATABASE: z.string().min(1),
  INGEST_DSN_SCHEME: z.string().default("http"),
  INGEST_DSN_HOST: z.string().min(1),
  INGEST_ALLOWED_ORIGINS: z.string().default("*"),
  INGEST_SECRET_SEED: z.string().min(1),
  EKEEPER_ORG: z.string().min(1).default("ekeeper"),
  MINIMAPS_STORAGE_PATH: z.string().min(1).default("./backend/data/minimaps"),
});

const parsed = envSchema.parse(process.env);

export const config = {
  ...parsed,
  isProd: parsed.NODE_ENV === "production",
  allowedDomains: parsed.GOOGLE_ALLOWED_DOMAINS.split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean),
  ingestAllowedOrigins: parsed.INGEST_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
