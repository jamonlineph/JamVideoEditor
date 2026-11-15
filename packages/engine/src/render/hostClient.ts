import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { EditError } from "@openedits/core";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (data: Record<string, unknown>) => void;
}

const IDLE_MS = 120_000;

/** Talks to the hidden Electron window that runs the compositor. Started on first use, stopped when idle. */
export class RenderHostClient {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  versions: Record<string, string> = {};

  private locate(): { electron: string; main: string } {
    const require = createRequire(import.meta.url);
    let electron: string;
    let main: string;
    try {
      electron = require("electron") as unknown as string;
      main = path.join(path.dirname(require.resolve("@openedits/render-host/package.json")), "dist", "main.cjs");
    } catch (e) {
      throw new EditError("INTERNAL", `The render host is not installed: ${(e as Error).message}`);
    }
    if (typeof electron !== "string" || !fs.existsSync(electron)) throw new EditError("INTERNAL", "Electron is not installed (run: node node_modules/electron/install.js)");
    if (!fs.existsSync(main)) throw new EditError("INTERNAL", "The render host is not built (run: npm run build)");
    return { electron, main };
  }

  private start(): Promise<void> {
    if (this.child && this.child.connected) return Promise.resolve();
    if (this.starting) return this.starting;
    const { electron, main } = this.locate();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.starting = new Promise<void>((resolve, reject) => {
      // Chromium refuses to start as root with its sandbox on (containers, CI).
      const args = [main, ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
      const child = spawn(electron, args, { stdio: ["ignore", "ignore", process.env.OPENEDITS_RENDER_DEBUG ? "inherit" : "ignore", "ipc"], env });
      this.child = child;
      const timer = setTimeout(() => fail(new Error("The render host did not start within 30 s")), 30_000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        this.starting = null;
        if (this.child === child) this.child = null;
        child.kill("SIGKILL");
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        reject(new EditError("INTERNAL", e.message));
      };
      child.on("error", fail);
      child.on("exit", (code, signal) => fail(new Error(`The render host exited (${code ?? signal})`)));
      child.on("message", (msg: { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; progress?: Record<string, unknown>; message?: string; versions?: Record<string, string> }) => {
        if (msg.type === "ready") {
          clearTimeout(timer);
          this.versions = msg.versions ?? {};
          this.starting = null;
          resolve();
          return;
        }
        if (msg.type === "fatal") return fail(new Error(`Render host crashed: ${msg.message}`));
        if (msg.type === "log") {
          if (process.env.OPENEDITS_RENDER_DEBUG) process.stderr.write(`[render-host] ${msg.message}\n`);
          return;
        }
        if (msg.id === undefined) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.progress) return p.onProgress?.(msg.progress);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new EditError("INTERNAL", `Render failed: ${msg.error}`));
      });
    });
    return this.starting;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.dispose();
      else this.touch();
    }, IDLE_MS);
    this.idleTimer.unref();
  }

  async request<T>(method: string, params: unknown, opts: { onProgress?: (data: Record<string, unknown>) => void; signal?: AbortSignal } = {}): Promise<T> {
    await this.start();
    this.touch();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.child?.send({ method: "cancel", params: { id } });
      opts.signal?.addEventListener("abort", abort, { once: true });
      const done = () => opts.signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v as T);
        },
        reject: (e) => {
          done();
          reject(e);
        },
        onProgress: opts.onProgress,
      });
      this.child!.send({ id, method, params }, (err) => {
        if (err) {
          this.pending.delete(id);
          done();
          reject(new EditError("INTERNAL", `Could not reach the render host: ${err.message}`));
        }
      });
    });
  }

  get running() {
    return !!this.child?.connected;
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child) {
      child.removeAllListeners();
      child.kill("SIGKILL");
    }
    for (const p of this.pending.values()) p.reject(new EditError("INTERNAL", "The render host was stopped"));
    this.pending.clear();
  }
}
