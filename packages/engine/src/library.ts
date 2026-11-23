import { openDatabase, transaction, type Database } from "./sqlite.js";

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  openedAt: number | null;
  pinned: boolean;
  favorite: boolean;
  thumbnailPath: string | null;
  durationSeconds: number;
  aspectRatio: string;
  dir: string;
}

export type ProjectFilter = "all" | "pinned" | "favorites";
export type ProjectSort = "updated" | "created" | "name" | "opened";

interface Raw {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  opened_at: number | null;
  pinned: number;
  favorite: number;
  thumbnail_path: string | null;
  duration_seconds: number;
  aspect_ratio: string;
  dir: string;
}

function toRow(r: Raw): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    openedAt: r.opened_at,
    pinned: !!r.pinned,
    favorite: !!r.favorite,
    thumbnailPath: r.thumbnail_path,
    durationSeconds: r.duration_seconds,
    aspectRatio: r.aspect_ratio,
    dir: r.dir,
  };
}

/** The project library (`Project.db`): one row per project, used by the home screen grid. */
export class Library {
  private db: Database;

  constructor(file: string) {
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        opened_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        thumbnail_path TEXT,
        duration_seconds REAL NOT NULL DEFAULT 0,
        aspect_ratio TEXT NOT NULL DEFAULT '9:16',
        dir TEXT NOT NULL
      );
    `);
  }

  create(row: { id: string; name: string; dir: string; aspectRatio: string; now: number }): ProjectRow {
    this.db
      .prepare("INSERT INTO projects (id, name, created_at, updated_at, opened_at, dir, aspect_ratio) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.now, row.now, row.now, row.dir, row.aspectRatio);
    return this.get(row.id)!;
  }

  restore(row: ProjectRow) {
    this.db.prepare(`INSERT INTO projects
      (id, name, dir, aspect_ratio, created_at, updated_at, opened_at, pinned, favorite, thumbnail_path, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.name, row.dir, row.aspectRatio, row.createdAt, row.updatedAt, row.openedAt,
        Number(row.pinned), Number(row.favorite), row.thumbnailPath, row.durationSeconds);
  }

  get(id: string): ProjectRow | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  list(opts: { filter?: ProjectFilter; sort?: ProjectSort; query?: string } = {}): ProjectRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.filter === "pinned") where.push("pinned = 1");
    if (opts.filter === "favorites") where.push("favorite = 1");
    if (opts.query) {
      where.push("name LIKE ?");
      args.push(`%${opts.query}%`);
    }
    const order = {
      updated: "updated_at DESC",
      created: "created_at DESC",
      name: "name COLLATE NOCASE ASC",
      opened: "COALESCE(opened_at, 0) DESC",
    }[opts.sort ?? "updated"];
    const sql = `SELECT * FROM projects ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY pinned DESC, ${order}`;
    return (this.db.prepare(sql).all(...args) as unknown as Raw[]).map(toRow);
  }

  rename(id: string, name: string, now: number) {
    this.db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
  }

  togglePin(id: string): boolean {
    this.db.prepare("UPDATE projects SET pinned = 1 - pinned WHERE id = ?").run(id);
    return this.get(id)!.pinned;
  }

  toggleFavorite(id: string): boolean {
    this.db.prepare("UPDATE projects SET favorite = 1 - favorite WHERE id = ?").run(id);
    return this.get(id)!.favorite;
  }

  touchOpened(id: string, now: number) {
    this.db.prepare("UPDATE projects SET opened_at = ? WHERE id = ?").run(now, id);
  }

  updateSummary(id: string, s: { name?: string; durationSeconds?: number; aspectRatio?: string; updatedAt: number; thumbnailPath?: string }) {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare("UPDATE projects SET name = ?, duration_seconds = ?, aspect_ratio = ?, updated_at = ?, thumbnail_path = ? WHERE id = ?")
      .run(s.name ?? cur.name, s.durationSeconds ?? cur.durationSeconds, s.aspectRatio ?? cur.aspectRatio, s.updatedAt, s.thumbnailPath ?? cur.thumbnailPath, id);
  }

  delete(id: string) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  close() {
    this.db.close();
  }
}
