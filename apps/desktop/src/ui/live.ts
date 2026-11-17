import { ipcRenderer } from "electron";
import { applyPatches, enablePatches, type Patch } from "immer";
import { useEffect, useState, useSyncExternalStore } from "react";
import { pathToFileURL } from "node:url";
import type { Project } from "@openedits/core";

enablePatches();

export interface AppState {
  screen: "home" | "editor" | "loading";
  openProjectId: string | null;
  selection: { elementIds: string[] };
  playheadSeconds: number;
  isPlaying: boolean;
  loop: boolean;
  activeTool: string | null;
  homeSelection: string[];
  gridGuides: boolean;
  teleprompterOpen: boolean;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "agent";
  text: string;
}

export interface LiveState {
  connected: boolean;
  appState: AppState | null;
  project: Project | null;
  version: number;
  /** Latest edit, for the "who changed what" indicator. */
  lastChange: { label: string; source: string; at: number } | null;
  toasts: Toast[];
  /** Bumped whenever the project changes (cheap dependency for effects). */
  revision: number;
}

export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type Listener = () => void;
type UiRequestHandler = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Connection to the engine's /live channel. Every UI action is a tool call (the same handlers MCP
 * agents use); project changes from anyone arrive as immer patches.
 */
export class Live {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; tool: string }>();
  private listeners = new Set<Listener>();
  private toastSeq = 0;
  private uiHandler: UiRequestHandler | null = null;
  state: LiveState = { connected: false, appState: null, project: null, version: 0, lastChange: null, toasts: [], revision: 0 };

  constructor(private url: string) {}

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "hello") {
          this.set({ connected: true, appState: msg.appState, project: msg.project?.state ?? null, version: msg.project?.version ?? 0, revision: this.state.revision + 1 });
          ws.send(JSON.stringify({ type: "register", role: "ui" }));
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (msg.type === "appState") this.set({ appState: msg.appState });
        else if (msg.type === "change") void this.onChange(msg);
        else if (msg.type === "result") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new ToolError(msg.error?.code ?? "INTERNAL", msg.error?.message ?? `${p.tool} failed`));
        } else if (msg.type === "uiRequest") void this.onUiRequest(msg);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        const wasConnected = this.state.connected;
        this.set({ connected: false });
        for (const p of this.pending.values()) p.reject(new ToolError("INTERNAL", "Disconnected from the engine"));
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to the engine"));
        }
        if (wasConnected) this.toast("error", "Lost the connection to the engine. Reconnecting…");
        this.scheduleReconnect();
      };
    });
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Keep trying until the engine answers; the main process restarts it if it has died. */
  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        const info = (await ipcRenderer.invoke("ensure-engine")) as { port: number; token: string };
        this.url = `ws://127.0.0.1:${info.port}/live?token=${info.token}`;
      } catch {
        /* keep the last known address */
      }
      // A failed attempt closes its socket, which schedules the next one.
      this.connect().then(() => this.toast("info", "Reconnected to the engine"), () => {});
    }, 1000);
  }

  private async onChange(msg: { kind: string; version: number; label: string; source: string; patches: Patch[]; state?: Project; projectId: string }) {
    if (msg.kind === "close") {
      this.set({ project: null, version: 0, revision: this.state.revision + 1 });
      return;
    }
    if (msg.kind === "open" && msg.state) {
      this.set({ project: msg.state, version: msg.version, revision: this.state.revision + 1 });
      return;
    }
    const current = this.state.project;
    if (current && msg.version === this.state.version + 1 && current.id === msg.projectId) {
      this.set({ project: applyPatches(current, msg.patches), version: msg.version, revision: this.state.revision + 1, lastChange: { label: msg.label, source: msg.source, at: Date.now() } });
    } else {
      // Missed an update (or a different project): resync from the engine.
      const r = await this.call<{ version: number; project: Project }>("state");
      this.set({ project: r.project, version: r.version, revision: this.state.revision + 1, lastChange: { label: msg.label, source: msg.source, at: Date.now() } });
    }
    if (msg.source !== "ui" && msg.kind === "commit") this.toast("agent", `${msg.source.replace(/^mcp:/, "")}: ${msg.label}`);
  }

  /** Register the handler for requests the engine sends to the UI (voiceover recording). */
  onUi(handler: UiRequestHandler) {
    this.uiHandler = handler;
  }

  private async onUiRequest(msg: { id: number; command: string; args: Record<string, unknown> }) {
    try {
      if (!this.uiHandler) throw new Error("The UI cannot handle this request yet");
      const result = await this.uiHandler(msg.command, msg.args ?? {});
      this.ws?.send(JSON.stringify({ type: "uiResponse", id: msg.id, ok: true, result }));
    } catch (e) {
      this.ws?.send(JSON.stringify({ type: "uiResponse", id: msg.id, ok: false, error: (e as Error).message }));
    }
  }

  call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new ToolError("INTERNAL", "Not connected to the engine"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, tool });
      this.ws!.send(JSON.stringify({ type: "call", id, tool, args }));
    });
  }

  /** Call a tool and show failures as a toast instead of throwing. */
  async run<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T | null> {
    try {
      const r = await this.call<T>(tool, args);
      const warnings = (r as { warnings?: string[] } | null)?.warnings;
      if (warnings?.length) this.toast("info", warnings[0]);
      return r;
    } catch (e) {
      this.toast("error", (e as Error).message);
      return null;
    }
  }

  toast(kind: Toast["kind"], text: string) {
    const t = { id: ++this.toastSeq, kind, text };
    this.set({ toasts: [...this.state.toasts.slice(-3), t] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((x) => x.id !== t.id) }), kind === "error" ? 6000 : 3500);
  }
}

/** True in the browser build (`openedits serve --web`), where the engine serves this page; false in the desktop app. */
export const WEB = __OPENEDITS_WEB__;

const params = new URLSearchParams(location.search);
export const WORKSPACE = WEB ? ((window as unknown as { __openedits?: { workspace?: string } }).__openedits?.workspace ?? "") : (params.get("workspace") ?? "");
// In the browser the page and /live share an origin, and the sign-in cookie carries the token.
export const live = new Live(WEB ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live` : `ws://127.0.0.1:${params.get("port")}/live?token=${params.get("token")}`);

export function useLive(): LiveState {
  return useSyncExternalStore(live.subscribe, () => live.state);
}

export function selectedElements(s: LiveState) {
  const p = s.project;
  return p ? (s.appState?.selection.elementIds ?? []).map((id) => p.elements[id]).filter(Boolean) : [];
}

/** Optional features this computer supports (reported by the engine). */
export interface Features {
  transcription: boolean;
  speech: boolean;
  vision: boolean;
}

let featuresPromise: Promise<Features> | undefined;

/** Feature flags, fetched once; null until the engine has answered. */
export function useFeatures(): Features | null {
  const [features, setFeatures] = useState<Features | null>(null);
  useEffect(() => {
    let alive = true;
    featuresPromise ??= live.call<{ features: Features }>("getSettings").then((r) => r.features);
    featuresPromise.then((f) => alive && setFeatures(f)).catch(() => (featuresPromise = undefined));
    return () => {
      alive = false;
    };
  }, []);
  return features;
}

/** A local file as a URL the page can load (spaces, "#" and Windows drive letters included). */
export function fileUrl(file: string): string {
  return pathToFileURL(file).href;
}

/** What the file manager is called on this platform, for "Show in …" buttons. */
export const FILE_MANAGER = process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "file manager";

/** Ctrl on Windows/Linux and Cmd on macOS, for multi-select clicks. */
export const additiveClick = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => e.metaKey || e.ctrlKey || e.shiftKey;
