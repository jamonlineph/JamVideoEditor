import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { HistoryEntry, MediaTranscript, Project, TranscriptIndex } from "@openedits/core";
import { migrateProject } from "@openedits/core";

export interface RevisionInfo {
  number: number;
  label: string;
  source: string;
  createdAt: number;
  version: number;
}

interface HistoryRow {
  seq: number;
  stack: "undo" | "redo";
  label: string;
  source: string;
  at: number;
  patches: string;
  inverse: string;
}

/**
 * Per-project SQLite store (`project.db`): the current document, numbered revisions,
 * and the persisted undo/redo stacks (so history survives restarts).
 */
export class ProjectStore {
  private db: Database.Database;
  readonly dir: string;
  readonly maxHistory: number;

  private constructor(dir: string, maxHistory = 300) {
    this.dir = dir;
    this.maxHistory = maxHistory;
    this.db = new Database(path.join(dir, "project.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, version INTEGER NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (number INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, stack TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, patches TEXT NOT NULL, inverse TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcripts (media_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
    `);
  }

  static create(dir: string, project: Project, now: number): ProjectStore {
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
    const store = new ProjectStore(dir);
    store.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('projectId', ?)").run(project.id);
    store.saveState(project, 0, now);
    return store;
  }

  static open(dir: string): ProjectStore {
    if (!fs.existsSync(path.join(dir, "project.db"))) throw new Error(`No project.db in ${dir}`);
    return new ProjectStore(dir);
  }

  load(): { project: Project; version: number } {
    const row = this.db.prepare("SELECT json, version FROM state WHERE id = 1").get() as { json: string; version: number } | undefined;
    if (!row) throw new Error("Project state missing");
    return { project: migrateProject(JSON.parse(row.json)), version: row.version };
  }

  saveState(project: Project, version: number, now: number) {
    this.db.prepare("INSERT OR REPLACE INTO state (id, json, version, saved_at) VALUES (1, ?, ?, ?)").run(JSON.stringify(project), version, now);
  }

  saveRevision(project: Project, version: number, label: string, source: string, now: number): RevisionInfo {
    const r = this.db.prepare("INSERT INTO revisions (label, source, created_at, version, json) VALUES (?, ?, ?, ?, ?)").run(label, source, now, version, JSON.stringify(project));
    return { number: Number(r.lastInsertRowid), label, source, createdAt: now, version };
  }

  listRevisions(): RevisionInfo[] {
    return (this.db.prepare("SELECT number, label, source, created_at, version FROM revisions ORDER BY number").all() as { number: number; label: string; source: string; created_at: number; version: number }[]).map((r) => ({
      number: r.number,
      label: r.label,
      source: r.source,
      createdAt: r.created_at,
      version: r.version,
    }));
  }

  getRevision(n: number): Project | undefined {
    const r = this.db.prepare("SELECT json FROM revisions WHERE number = ?").get(n) as { json: string } | undefined;
    return r ? migrateProject(JSON.parse(r.json)) : undefined;
  }

  // ---- transcripts (analysis data: not part of undo history)

  private transcriptCache: TranscriptIndex | null = null;

  loadTranscripts(): TranscriptIndex {
    if (!this.transcriptCache) {
      const rows = this.db.prepare("SELECT media_id, json FROM transcripts").all() as { media_id: string; json: string }[];
      this.transcriptCache = Object.fromEntries(rows.map((r) => [r.media_id, JSON.parse(r.json) as MediaTranscript]));
    }
    return this.transcriptCache;
  }

  saveTranscript(t: MediaTranscript) {
    this.db.prepare("INSERT OR REPLACE INTO transcripts (media_id, created_at, json) VALUES (?, ?, ?)").run(t.mediaId, t.createdAt, JSON.stringify(t));
    this.transcriptCache = { ...this.loadTranscripts(), [t.mediaId]: t };
  }

  /** Reserve `count` consecutive word ids. Ids are never reused, so edits that name them stay unambiguous. */
  allocateWordIds(count: number): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'nextWordId'").get() as { value: string } | undefined;
    const first = row ? Number(row.value) : 1;
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('nextWordId', ?)").run(String(first + count));
    return first;
  }

  // ---- undo history persistence

  loadHistory(): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
    const rows = this.db.prepare("SELECT * FROM history ORDER BY seq").all() as HistoryRow[];
    const toEntry = (r: HistoryRow): HistoryEntry => ({ label: r.label, source: r.source, at: r.at, patches: JSON.parse(r.patches), inversePatches: JSON.parse(r.inverse) });
    return { undo: rows.filter((r) => r.stack === "undo").map(toEntry), redo: rows.filter((r) => r.stack === "redo").map(toEntry) };
  }

  private insertHistory(stack: "undo" | "redo", e: HistoryEntry) {
    this.db.prepare("INSERT INTO history (stack, label, source, at, patches, inverse) VALUES (?, ?, ?, ?, ?, ?)").run(stack, e.label, e.source, e.at, JSON.stringify(e.patches), JSON.stringify(e.inversePatches));
  }

  private moveTop(from: "undo" | "redo", to: "undo" | "redo") {
    const row = this.db.prepare("SELECT * FROM history WHERE stack = ? ORDER BY seq DESC LIMIT 1").get(from) as HistoryRow | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM history WHERE seq = ?").run(row.seq);
    this.db.prepare("INSERT INTO history (stack, label, source, at, patches, inverse) VALUES (?, ?, ?, ?, ?, ?)").run(to, row.label, row.source, row.at, row.patches, row.inverse);
  }

  /** Persist a commit/undo/redo together with the new state, atomically. */
  recordEvent(kind: "commit" | "undo" | "redo", entry: HistoryEntry, project: Project, version: number, now: number) {
    const tx = this.db.transaction(() => {
      if (kind === "commit") {
        this.db.prepare("DELETE FROM history WHERE stack = 'redo'").run();
        this.insertHistory("undo", entry);
        const count = (this.db.prepare("SELECT COUNT(*) AS n FROM history WHERE stack = 'undo'").get() as { n: number }).n;
        if (count > this.maxHistory) {
          this.db.prepare("DELETE FROM history WHERE seq IN (SELECT seq FROM history WHERE stack = 'undo' ORDER BY seq LIMIT ?)").run(count - this.maxHistory);
        }
      } else if (kind === "undo") this.moveTop("undo", "redo");
      else this.moveTop("redo", "undo");
      this.saveState(project, version, now);
    });
    tx();
  }

  close() {
    this.db.close();
  }
}
