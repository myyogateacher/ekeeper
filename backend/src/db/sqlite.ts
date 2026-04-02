import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";

mkdirSync(dirname(config.SQLITE_PATH), { recursive: true });

export const sqlite = new Database(config.SQLITE_PATH, { create: true, strict: true });
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
