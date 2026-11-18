import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { EditError } from "@openedits/core";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (data: Record<string, unknown>) => void;
}

interface HostMessage {
  type?: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  progress?: Record<string, unknown>;
  message?: string;
  versions?: Record<string, string>;
}

/** How the engine reaches the compositor page: a spawned Electron window (desktop) or a page that connected to it (Android). */
interface Transport {
  send(msg: unknown, cb?: (err: Error | null) => void): void;
  readonly connected: boolean;
  /** Stop listening; for a spawned window also kill it. */
  close(): void;
}

const IDLE_MS = 120_000;

/** Where the compositor runs: "electron" (spawned hidden window) or "web" (a page that connects to /web/render-host). */
export const renderHostMode = (): "electron" | "web" => (process.env.OPENEDITS_RENDER_HOST === "web" ? "web" : "electron");

// ---- Web mode: the compositor is a page that opens a socket to the engine. On Android the app keeps
// it open in a WebView of its own; there is no Electron there to start. One page serves the engine at a time.

/** The engine side of a connected render page: hand it each message the page sends, and say when it closes. */
export interface RenderPageLink {
  message(msg: unknown): void;
  closed(): void;
}

interface PageSocket {
  send(text: string, cb?: (err?: Error) => void): void;
  close(): void;
  readonly open: boolean;
}

type PageListener = (page: { socket: PageSocket; link: { onMessage?: (msg: HostMessage) => void; onClose?: () => void } }) => void;

let currentPage: { socket: PageSocket; ready: boolean; versions: Record<string, string>; link: { onMessage?: (msg: HostMessage) => void; onClose?: () => void } } | null = null;
const pageWaiters = new Set<PageListener>();

/** Called by the HTTP server when a render page connects. A newer page replaces an older one. */
export function attachRenderPage(socket: PageSocket): RenderPageLink {
  const previous = currentPage;
  const entry = { socket, ready: false, versions: {} as Record<string, string>, link: {} as { onMessage?: (msg: HostMessage) => void; onClose?: () => void } };
  currentPage = entry;
  if (previous) {
    previous.link.onClose?.();
    previous.socket.close();
  }
  return {
    message(raw) {
      const msg = raw as HostMessage;
      if (msg?.type === "ready") {
        entry.ready = true;
        entry.versions = msg.versions ?? {};
        for (const w of [...pageWaiters]) w(entry);
        return;
      }
      entry.link.onMessage?.(msg);
    },
    closed() {
      if (currentPage === entry) currentPage = null;
      entry.link.onClose?.();
    },
  };
}

/** Whether a render page is connected and ready (web mode). */
export function renderPageConnected(): boolean {
  return !!currentPage?.ready && currentPage.socket.open;
}

/** Talks to the page that runs the compositor (the hidden Electron window, or a connected web page). Started on first use, stopped when idle. */
export class RenderHostClient {
  private transport: Transport | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  versions: Record<string, string> = {};

  private locate(): { electron: string; main: string | null } {
    // Inside the packaged app the app's own binary is the render host (entry.cjs switches on a flag).
    if (process.env.OPENEDITS_ELECTRON) return { electron: process.env.OPENEDITS_ELECTRON, main: null };
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

  /** A message from the page: a progress report or the answer to a request. */
  private handle(msg: HostMessage) {
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
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(new EditError("INTERNAL", e.message));
    this.pending.clear();
  }

  private start(): Promise<void> {
    if (this.transport?.connected) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = renderHostMode() === "web" ? this.startWeb() : this.startElectron();
    return this.starting;
  }

  /** Web mode: use the connected render page, waiting a while for one to (re)connect. */
  private startWeb(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const use: PageListener = (page) => {
        pageWaiters.delete(use);
        clearTimeout(timer);
        const entry = page as NonNullable<typeof currentPage>;
        const transport: Transport = {
          send: (msg, cb) => {
            if (!entry.socket.open) return cb?.(new Error("the render page closed"));
            entry.socket.send(JSON.stringify(msg), (err) => cb?.(err ?? null));
          },
          get connected() {
            return currentPage === entry && entry.socket.open;
          },
          close: () => {
            entry.link.onMessage = undefined;
            entry.link.onClose = undefined;
          },
        };
        entry.link.onMessage = (msg) => {
          if (msg.type === "fatal") {
            if (this.transport === transport) this.transport = null;
            this.failAll(new Error(`Render page crashed: ${msg.message}`));
            return;
          }
          this.handle(msg);
        };
        entry.link.onClose = () => {
          if (this.transport === transport) this.transport = null;
          this.failAll(new Error("The render page closed"));
        };
        this.transport = transport;
        this.versions = entry.versions;
        this.starting = null;
        resolve();
      };
      const timer = setTimeout(() => {
        pageWaiters.delete(use);
        this.starting = null;
        reject(new EditError("INTERNAL", "The render page did not connect within 60 s (OPENEDITS_RENDER_HOST=web: open /render-host.html from the engine)"));
      }, 60_000);
      if (renderPageConnected()) use(currentPage!);
      else pageWaiters.add(use);
    });
  }

  private startElectron(): Promise<void> {
    const { electron, main } = this.locate();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise<void>((resolve, reject) => {
      // Chromium refuses to start as root with its sandbox on (containers, CI).
      const args = [main ?? "--openedits-render-host", ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
      // No desktop session (a Linux VM or container, a Googlebook's Terminal, SSH): the compositor window is
      // never shown anyway, so run Chromium without a display server instead of failing to find one.
      if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.push("--ozone-platform=headless");
      const child = spawn(electron, args, { stdio: ["ignore", "ignore", process.env.OPENEDITS_RENDER_DEBUG ? "inherit" : "ignore", "ipc"], env });
      const transport: Transport = {
        send: (msg, cb) => {
          child.send(msg as object, (err) => cb?.(err ?? null));
        },
        get connected() {
          return child.connected;
        },
        close: () => {
          child.removeAllListeners();
          child.kill("SIGKILL");
        },
      };
      this.transport = transport;
      const timer = setTimeout(() => fail(new Error("The render host did not start within 30 s")), 30_000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        this.starting = null;
        if (this.transport === transport) this.transport = null;
        child.kill("SIGKILL");
        this.failAll(e);
        reject(new EditError("INTERNAL", e.message));
      };
      child.on("error", fail);
      child.on("exit", (code, signal) => fail(new Error(`The render host exited (${code ?? signal})`)));
      child.on("message", (msg: HostMessage) => {
        if (msg.type === "ready") {
          clearTimeout(timer);
          this.versions = msg.versions ?? {};
          this.starting = null;
          resolve();
          return;
        }
        if (msg.type === "fatal") return fail(new Error(`Render host crashed: ${msg.message}`));
        this.handle(msg);
      });
    });
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
    const transport = this.transport!;
    return new Promise<T>((resolve, reject) => {
      const abort = () => transport.send({ method: "cancel", params: { id } });
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
      transport.send({ id, method, params }, (err) => {
        if (err) {
          this.pending.delete(id);
          done();
          reject(new EditError("INTERNAL", `Could not reach the render host: ${err.message}`));
        }
      });
    });
  }

  get running() {
    return !!this.transport?.connected;
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const transport = this.transport;
    this.transport = null;
    this.starting = null;
    // A connected page stays open for the next request; only the engine's interest in it ends.
    transport?.close();
    this.failAll(new Error("The render host was stopped"));
  }
}
