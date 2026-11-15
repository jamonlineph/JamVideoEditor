import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addMediaToTimeline } from "@openedits/core";
import { EngineHost, type EngineOptions } from "./host.js";
import { mediaKindFromExt } from "./media/probe.js";
import { resolveWorkspace, type WorkspacePaths } from "./workspace.js";

export type AutopilotStatus = "running" | "done" | "failed";

export interface AutopilotJob {
  id: string;
  files: string[];
  status: AutopilotStatus;
  step: string;
  createdAt: number;
  finishedAt?: number;
  projectId?: string;
  projectName?: string;
  output?: string;
  durationSeconds?: number;
  removedSeconds?: number;
  notes?: string[];
  error?: string;
}

function jobsDir(paths: WorkspacePaths) {
  const dir = path.join(paths.root, ".autopilot", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function save(paths: WorkspacePaths, job: AutopilotJob) {
  const file = path.join(jobsDir(paths), `${job.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** Autopilot job records, newest first (shared across processes through the workspace). */
export function listAutopilotJobs(paths: WorkspacePaths, limit = 50): AutopilotJob[] {
  const dir = jobsDir(paths);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AutopilotJob;
      } catch {
        return null;
      }
    })
    .filter((j): j is AutopilotJob => !!j)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Hands-free edit of dropped files in a separate engine instance (so it never touches the project the
 * creator has open): new project, STYLE.md first pass, optional render to the outbox.
 */
export async function autoEditFiles(files: string[], opts: { workspaceRoot?: string; render?: "preview" | "final" | "none"; name?: string; engine?: Partial<EngineOptions>; onStep?: (step: string) => void } = {}): Promise<AutopilotJob> {
  const paths = resolveWorkspace(opts.workspaceRoot);
  const job: AutopilotJob = { id: `ap_${Date.now().toString(36)}${randomUUID().slice(0, 4)}`, files: files.map((f) => path.resolve(f)), status: "running", step: "starting", createdAt: Date.now() };
  const step = (s: string) => {
    job.step = s;
    save(paths, job);
    opts.onStep?.(s);
  };
  save(paths, job);
  const host = EngineHost.create({ workspaceRoot: paths.root, restoreLastProject: false, persistSession: false, ...opts.engine });
  try {
    step("creating project");
    const name = opts.name ?? path.parse(job.files[0]).name;
    const project = host.newProject({ name });
    job.projectId = project.id;
    job.projectName = name;
    step("importing media");
    const imp = await host.importMedia(job.files, { source: "autopilot" });
    host.mutate("Add files to timeline", "autopilot", (c) => {
      for (const a of imp.assets) addMediaToTimeline(c, c.draft.media[a.id], {});
    });
    const before = host.project.tracks[0].elementIds.reduce((s, id) => s + host.project.elements[id].duration, 0);
    step("transcribing and editing");
    const render = opts.render === "none" ? undefined : opts.render ?? "final";
    const edit = host.transcripts.startAutoEdit("autopilot", {}, { render });
    const done = await host.jobs.wait(edit.id, 60 * 60_000);
    if (done.status !== "done") throw new Error(done.error?.message ?? `auto_edit ${done.status}`);
    const result = done.result as { notes?: string[]; render?: { path?: string; status?: string; error?: { message: string } } };
    const after = host.project.tracks[0].elementIds.reduce((s, id) => s + host.project.elements[id].duration, 0);
    job.durationSeconds = Math.round(after * 100) / 100;
    job.removedSeconds = Math.round((before - after) * 100) / 100;
    job.notes = result.notes ?? [];
    if (render) {
      if (!result.render?.path) throw new Error(`Render failed: ${result.render?.error?.message ?? result.render?.status ?? "unknown"}`);
      job.output = result.render.path;
    }
    job.status = "done";
    job.finishedAt = Date.now();
    step("done");
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error).message;
    job.finishedAt = Date.now();
    step("failed");
  } finally {
    host.dispose();
  }
  return job;
}

/** Watch the auto-edit folder: each new video (once its size is stable) becomes an autopilot job; sources move to auto-edit/done. */
export class AutopilotWatcher {
  private timer: NodeJS.Timeout | null = null;
  private sizes = new Map<string, number>();
  private busy = false;
  readonly paths: WorkspacePaths;

  constructor(private readonly opts: { workspaceRoot?: string; render?: "preview" | "final" | "none"; intervalMs?: number; log?: (m: string) => void; engine?: Partial<EngineOptions> } = {}) {
    this.paths = resolveWorkspace(opts.workspaceRoot);
  }

  start() {
    fs.mkdirSync(this.paths.autoEdit, { recursive: true });
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 2000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan; a file is picked up when its size has not changed since the previous scan. */
  async tick(): Promise<AutopilotJob[]> {
    if (this.busy) return [];
    this.busy = true;
    const out: AutopilotJob[] = [];
    try {
      for (const name of fs.readdirSync(this.paths.autoEdit).sort()) {
        if (name.startsWith(".")) continue;
        const file = path.join(this.paths.autoEdit, name);
        let size: number;
        try {
          const st = fs.statSync(file);
          if (!st.isFile() || mediaKindFromExt(name) !== "video") continue;
          size = st.size;
        } catch {
          continue;
        }
        if (this.sizes.get(file) !== size) {
          this.sizes.set(file, size);
          continue;
        }
        this.sizes.delete(file);
        const doneDir = path.join(this.paths.autoEdit, "done");
        fs.mkdirSync(doneDir, { recursive: true });
        let moved = path.join(doneDir, name);
        for (let n = 2; fs.existsSync(moved); n++) moved = path.join(doneDir, `${path.parse(name).name} (${n})${path.extname(name)}`);
        fs.renameSync(file, moved);
        this.opts.log?.(`autopilot: ${name}`);
        const job = await autoEditFiles([moved], { workspaceRoot: this.paths.root, render: this.opts.render, name: path.parse(name).name, engine: this.opts.engine, onStep: (s) => this.opts.log?.(`autopilot ${name}: ${s}`) });
        this.opts.log?.(`autopilot ${name}: ${job.status}${job.output ? ` -> ${job.output}` : ""}${job.error ? ` (${job.error})` : ""}`);
        out.push(job);
      }
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** Files waiting in the folder. */
  pending(): string[] {
    if (!fs.existsSync(this.paths.autoEdit)) return [];
    return fs.readdirSync(this.paths.autoEdit).filter((n) => !n.startsWith(".") && mediaKindFromExt(n) === "video");
  }
}
