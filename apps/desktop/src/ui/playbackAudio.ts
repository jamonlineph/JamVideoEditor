import fs from "node:fs";
import { buildAudioPlan, type Project } from "@openedits/core";
import { fileUrl, live, WEB } from "./live.js";

const WINDOW_SECONDS = 4;
const STARTUP_WAIT_MS = 1500;

type AudioWindow = { buffer: AudioBuffer; source?: AudioBufferSourceNode };
type AudioSession = {
  projectId: string;
  signature: string;
  end: number;
  abort: AbortController;
  origin: number | null;
  windows: Map<number, AudioWindow | null>;
};

const windowStart = (time: number) => Math.floor(time / WINDOW_SECONDS) * WINDOW_SECONDS;

/** Play sample-aligned WAV windows using one clock, preloading the next window for gapless audio. */
export class PlaybackAudio {
  private context: AudioContext | null = null;
  private session: AudioSession | null = null;
  private firstWindow: AudioBuffer | null = null;
  private request: Promise<void> | null = null;

  configure(project: Project, end: number) {
    const plan = buildAudioPlan(project);
    const signature = JSON.stringify(plan);
    if (this.session?.projectId === project.id && this.session.signature === signature && this.session.end === end) return;
    this.stop();
    if (!plan.length) return;
    try {
      this.context ??= new AudioContext({ sampleRate: 48_000 });
      void this.context.resume().catch(() => {});
    } catch {
      return;
    }
    this.session = { projectId: project.id, signature, end, abort: new AbortController(), origin: null, windows: new Map() };
  }

  async prime(time: number) {
    const pending = this.load(windowStart(time));
    if (!pending) return;
    // Give the first window a short head start. A slow disk/codec must not freeze the picture.
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
    if (!session || !context || this.request || start >= session.end || session.windows.has(start)) return;
    const signal = session.abort.signal;
    this.request = (async () => {
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
        if (start === 0) this.firstWindow = buffer;
      } catch {
        // A failed window stays silent for this play pass.
        if (!signal.aborted) session.windows.set(start, null);
      } finally {
        this.request = null;
      }
    })();
    return this.request;
  }

  rewind() {
    const session = this.session;
    if (!session) return;
    this.clearWindows(session);
    if (this.firstWindow) session.windows.set(0, { buffer: this.firstWindow });
    this.session = { ...session, abort: new AbortController(), origin: null };
  }

  stop() {
    if (this.session) this.clearWindows(this.session);
    this.session = null;
    this.firstWindow = null;
    void this.context?.suspend().catch(() => {});
  }

  private clearWindows(session: AudioSession) {
    session.abort.abort();
    for (const window of session.windows.values()) window?.source?.stop();
    session.windows.clear();
  }

  dispose() {
    this.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
