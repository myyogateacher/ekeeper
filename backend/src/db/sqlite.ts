import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path, { dirname } from "node:path";
import { config } from "../config";

const sqlitePath = path.isAbsolute(config.SQLITE_PATH)
  ? config.SQLITE_PATH
  : path.resolve(import.meta.dir, "../../..", config.SQLITE_PATH);

mkdirSync(dirname(sqlitePath), { recursive: true });

export const sqlite = new Database(sqlitePath, { create: true, strict: true });
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA journal_mode = WAL;");

export function one<T>(query: string, params: SQLQueryBindings[] = []): T | null {
  return sqlite.query(query).get(...params) as T | null;
}

export function all<T>(query: string, params: SQLQueryBindings[] = []): T[] {
  return sqlite.query(query).all(...params) as T[];
}

export function run(query: string, params: SQLQueryBindings[] = []) {
  return sqlite.query(query).run(...params);
}
