import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite from Node's standard library (`node:sqlite`, Node 22.13+ and the Node built into
 * Electron), so the engine has no native modules to compile for each platform.
 */
let ctor: typeof DatabaseSync | undefined;

function load(): typeof DatabaseSync {
  if (ctor) return ctor;
  // Node 22 labels node:sqlite experimental and prints a warning on every start; keep it quiet.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/SQLite is an experimental feature/i.test(text ?? "")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    ctor = (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  } finally {
    process.emitWarning = emit;
  }
  return ctor;
}

export type Database = DatabaseSync;

/** Open a database file with WAL journaling and a busy timeout (shared by the library and projects). */
export function openDatabase(file: string, readOnly = false): Database {
  const Db = load();
  const db = new Db(file, { readOnly });
  db.exec("PRAGMA busy_timeout = 3000;");
  if (!readOnly) db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

/** Run `fn` in one transaction (rolled back if it throws). */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
