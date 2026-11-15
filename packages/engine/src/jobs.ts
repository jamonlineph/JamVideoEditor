import { EventEmitter } from "node:events";
import { EditError } from "@openedits/core";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  kind: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message?: string;
  createdAt: number;
  finishedAt?: number;
  projectId?: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number, message?: string): void;
}

interface Entry {
  info: JobInfo;
  controller: AbortController;
  done: Promise<void>;
}

/** Tracks long-running work (renders, exports) so agents can poll or wait on it. */
export class JobManager extends EventEmitter {
  private jobs = new Map<string, Entry>();
  private counter = 0;

  start(kind: string, run: (ctx: JobContext) => Promise<unknown>, meta: { projectId?: string } = {}): JobInfo {
    const id = `job_${(++this.counter).toString(36)}${Date.now().toString(36).slice(-4)}`;
    const controller = new AbortController();
    const info: JobInfo = { id, kind, status: "running", progress: 0, createdAt: Date.now(), ...meta };
    const ctx: JobContext = {
      signal: controller.signal,
      progress: (fraction, message) => {
        info.progress = Math.max(0, Math.min(1, fraction));
        if (message) info.message = message;
        this.emit("progress", this.snapshot(info));
      },
    };
    const done = run(ctx)
      .then((result) => {
        info.status = "done";
        info.progress = 1;
        info.result = result;
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) info.status = "cancelled";
        else {
          info.status = "failed";
          info.error = e instanceof EditError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error)?.message ?? String(e) };
        }
      })
      .finally(() => {
        info.finishedAt = Date.now();
        this.emit("finished", this.snapshot(info));
      });
    this.jobs.set(id, { info, controller, done });
    return this.snapshot(info);
  }

  private snapshot(info: JobInfo): JobInfo {
    return { ...info };
  }

  get(id: string): JobInfo {
    const e = this.jobs.get(id);
    if (!e) throw new EditError("INVALID_ARGUMENT", `No job "${id}"`, { jobs: [...this.jobs.keys()].slice(-10) });
    return this.snapshot(e.info);
  }

  list(kind?: string): JobInfo[] {
    return [...this.jobs.values()].filter((e) => !kind || e.info.kind === kind).map((e) => this.snapshot(e.info));
  }

  latest(kind: string, projectId?: string): JobInfo | undefined {
    return this.list(kind).filter((j) => !projectId || j.projectId === projectId).at(-1);
  }

  cancel(id: string): JobInfo {
    const e = this.jobs.get(id);
    if (!e) throw new EditError("INVALID_ARGUMENT", `No job "${id}"`);
    if (e.info.status === "running") e.controller.abort();
    return this.snapshot(e.info);
  }

  /** Wait up to `ms` for a job to finish; returns its current state either way. */
  async wait(id: string, ms: number): Promise<JobInfo> {
    const e = this.jobs.get(id);
    if (!e) throw new EditError("INVALID_ARGUMENT", `No job "${id}"`);
    if (e.info.status === "running" && ms > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([e.done, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
    }
    return this.snapshot(e.info);
  }

  async cancelAll() {
    for (const e of this.jobs.values()) if (e.info.status === "running") e.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((e) => e.done));
  }
}
