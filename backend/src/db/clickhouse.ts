import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "../config";

let client: ClickHouseClient | null = null;

export function getClickHouseClient(database = config.CLICKHOUSE_DATABASE): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: config.CLICKHOUSE_URL,
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
      database,
    });
  }

  return client;
}

export function createAdminClickHouseClient(): ClickHouseClient {
  return createClient({
    url: config.CLICKHOUSE_URL,
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
  });
}
