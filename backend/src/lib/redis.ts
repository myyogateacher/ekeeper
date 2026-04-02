import { createClient } from "redis";
import { config } from "../config";

export const redis = createClient({
  socket: {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
  },
  password: config.REDIS_PASSWORD || undefined,
  database: config.REDIS_DB,
});

redis.on("error", (error) => {
  console.error("[redis] connection error", error);
});

let connectPromise: Promise<typeof redis> | null = null;

export async function connectRedis() {
  if (redis.isReady) {
    return redis;
  }

  if (!connectPromise) {
    connectPromise = redis.connect().then(() => redis);
  }

  return connectPromise;
}
