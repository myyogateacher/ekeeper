import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { createAdminClickHouseClient, getClickHouseClient } from "../db/clickhouse";
import { all, run, sqlite } from "../db/sqlite";
import type { MigrationRecord } from "@ekeeper/shared";

interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

function parseMigrationName(fileName: string): MigrationFile {
  const contents = readFileSync(fileName, "utf8");
  const basename = path.basename(fileName, ".sql");
  const [version, ...nameParts] = basename.split("_");

  return {
    version,
    name: nameParts.join("_"),
    checksum: createHash("sha256").update(contents).digest("hex"),
    sql: contents,
  };
}

function loadMigrations(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => parseMigrationName(path.join(directory, file)));
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function toClickHouseDateTime(value: string | Date): string {
  const iso = typeof value === "string" ? value : value.toISOString();
  return iso.replace("T", " ").replace("Z", "");
}

export async function runSqliteMigrations() {
  run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Map(
    all<MigrationRecord>("SELECT version, name, checksum, applied_at as appliedAt FROM schema_migrations").map(
      (record) => [record.version, record],
    ),
  );

  const migrations = loadMigrations(path.join(import.meta.dir, "../migrations/sqlite"));

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(`SQLite migration checksum mismatch for version ${migration.version}`);
      }
      continue;
    }

    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      run(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        [migration.version, migration.name, migration.checksum, new Date().toISOString()],
      );
    })();
  }
}

export async function runClickHouseMigrations() {
  const adminClient = createAdminClickHouseClient();
  await adminClient.command({
    query: `CREATE DATABASE IF NOT EXISTS ${config.CLICKHOUSE_DATABASE}`,
  });

  const client = getClickHouseClient();
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version String,
        name String,
        checksum String,
        applied_at DateTime64(3, 'UTC')
      )
      ENGINE = ReplacingMergeTree()
      ORDER BY version
    `,
  });

  const existingResult = await client.query({
    query: "SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations",
    format: "JSONEachRow",
  });
  const existingRows = (await existingResult.json()) as MigrationRecord[];
  const applied = new Map(existingRows.map((row) => [row.version, row]));

  const migrations = loadMigrations(path.join(import.meta.dir, "../migrations/clickhouse"));
  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(`ClickHouse migration checksum mismatch for version ${migration.version}`);
      }
      continue;
    }

    const templatedSql = migration.sql.replaceAll("__CLICKHOUSE_DATABASE__", config.CLICKHOUSE_DATABASE);
    for (const statement of splitStatements(templatedSql)) {
      await client.command({ query: statement });
    }

    await client.insert({
      table: "schema_migrations",
      values: [
        {
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          applied_at: toClickHouseDateTime(new Date()),
        },
      ],
      format: "JSONEachRow",
    });
  }
}

export async function runMigrations() {
  await runSqliteMigrations();
  await runClickHouseMigrations();
}
