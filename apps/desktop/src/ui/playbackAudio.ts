import fs from "node:fs";
import { buildAudioPlan, type Project } from "@openedits/core";
import { fileUrl, live, WEB } from "./live.js";

const WINDOW_SECONDS = 4;
const STARTUP_WAIT_MS = 120;
const CACHED_WINDOWS = 4;

type AudioWindow = { buffer: AudioBuffer; source?: AudioBufferSourceNode };
type AudioSession = {
  projectId: string;
  signature: string;
  end: number;
  abort: AbortController;
  active: boolean;
  origin: number | null;
  windows: Map<number, AudioWindow | null>;
  request?: { start: number; task: Promise<void> };
};

const windowStart = (time: number) => Math.floor(time / WINDOW_SECONDS) * WINDOW_SECONDS;

/** Play sample-aligned WAV windows using one clock, preloading the next window for gapless audio. */
export class PlaybackAudio {
  private context: AudioContext | null = null;
  private session: AudioSession | null = null;
  private cacheSignature: string | undefined;
  private buffers = new Map<number, AudioBuffer>();

  configure(project: Project, end: number) {
    this.setMix(project, end);
    if (!this.session) return;
    this.session.active = true;
    void this.context?.resume().catch(() => {});
  }

  warm(project: Project, end: number, time: number) {
    this.setMix(project, end);
    if (this.context?.state === "running") void this.context.suspend().catch(() => {});
    void this.load(windowStart(time));
  }

  private setMix(project: Project, end: number) {
    const plan = buildAudioPlan(project);
    const signature = JSON.stringify([project.id, end, plan]);
    if (this.session?.signature === signature) return;
    this.stop();
    if (this.cacheSignature !== signature) {
      this.buffers.clear();
      this.cacheSignature = signature;
    }
    if (!plan.length) return;
    try {
      this.context ??= new AudioContext({ sampleRate: 48_000 });
    } catch {
      return;
    }
    this.session = { projectId: project.id, signature, end, abort: new AbortController(), active: false, origin: null, windows: new Map() };
  }

  async prime(time: number) {
    const start = windowStart(time);
    const session = this.session;
    if (session?.request && session.request.start !== start) {
      // A seek can move Play away from the window prepared while paused.
      session.abort.abort();
      session.abort = new AbortController();
      session.request = undefined;
    }
    const pending = this.load(start);
    if (!pending) return;
    // Briefly wait for the initial mix. Late windows join at the current audio-clock offset.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, STARTUP_WAIT_MS); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  time(fallback: number): number {
    if (this.context?.state !== "running" || !this.session) return fallback;
    this.session.origin ??= this.context.currentTime - fallback;
    return this.context.currentTime - this.session.origin;
  }

  update(time: number) {
    const session = this.session;
    const context = this.context;
    if (!session || !context || session.origin === null || context.state !== "running") return;
    const first = windowStart(time);
    for (const start of session.windows.keys()) {
      if (start < first) session.windows.delete(start);
    }
    for (const start of [first, first + WINDOW_SECONDS]) {
      if (start >= session.end) break;
      if (!session.windows.has(start)) {
        void this.load(start);
        continue;
      }
      const window = session.windows.get(start);
      if (!window || window.source) continue;
      const when = session.origin + start;
      const now = context.currentTime;
      const offset = Math.max(0, now - when);
      if (offset >= window.buffer.duration) continue;
      const source = context.createBufferSource();
      source.buffer = window.buffer;
      source.connect(context.destination);
      source.onended = () => source.disconnect();
      source.start(Math.max(now, when), offset);
      window.source = source;
    }
  }

  private load(start: number) {
    const session = this.session;
    const context = this.context;
    if (!session || !context || start >= session.end || session.windows.has(start)) return;
    const cached = this.buffers.get(start);
    if (cached) {
      // Keep the starting window and the most recently used windows for quick restarts.
      this.buffers.delete(start);
      this.buffers.set(start, cached);
      session.windows.set(start, { buffer: cached });
      return;
    }
    if (session.request) return session.request.start === start ? session.request.task : undefined;
    const signal = session.abort.signal;
    const task = (async () => {
      try {
        const result = await live.call<{ path: string; projectId: string }>("previewAudio", { startSeconds: start, durationSeconds: WINDOW_SECONDS });
        if (signal.aborted || result.projectId !== session.projectId) return;
        let data: ArrayBuffer;
        if (WEB) {
          const response = await fetch(fileUrl(result.path), { signal });
          if (!response.ok) throw new Error("Could not load playback audio");
          data = await response.arrayBuffer();
        } else {
          const bytes = await fs.promises.readFile(result.path, { signal });
          data = new Uint8Array(bytes).buffer;
        }
        const buffer = await context.decodeAudioData(data);
        if (signal.aborted) return;
        session.windows.set(start, { buffer });
        this.buffers.set(start, buffer);
        if (this.buffers.size > CACHED_WINDOWS) {
          const oldest = [...this.buffers.keys()].find((window) => window !== 0);
          if (oldest !== undefined) this.buffers.delete(oldest);
        }
      } catch {
        // A failed window stays silent for this play pass.
        if (!signal.aborted && session.active) session.windows.set(start, null);
      } finally {
        if (!signal.aborted) session.request = undefined;
      }
    })();
    session.request = { start, task };
    return task;
  }

  rewind() {
    const session = this.session;
    if (!session) return;
    this.clearWindows(session);
    this.session = { ...session, abort: new AbortController(), origin: null, windows: new Map(), request: undefined };
  }

  stop() {
    if (this.session) this.clearWindows(this.session);
    this.session = null;
    void this.context?.suspend().catch(() => {});
  }

  private clearWindows(session: AudioSession) {
    session.abort.abort();
    for (const window of session.windows.values()) window?.source?.stop();
    session.windows.clear();
  }

  dispose() {
    this.stop();
    this.buffers.clear();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
