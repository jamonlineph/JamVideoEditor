import { ipcRenderer } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { live, WORKSPACE } from "./live.js";
import { ui } from "./uiStore.js";

export interface RecorderState {
  phase: "idle" | "countdown" | "recording" | "saving";
  count: number;
  levelDb: number;
  elapsed: number;
  devices: { id: string; label: string }[];
  deviceId: string | null;
  error: string | null;
}

const FFMPEG = process.env.OPENEDITS_FFMPEG ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p)) ?? "ffmpeg";

/** Microphone recorder with a pre-roll countdown and a live dBFS meter; takes land on a voiceover lane. */
class VoiceRecorder {
  state: RecorderState = { phase: "idle", count: 0, levelDb: -90, elapsed: 0, devices: [], deviceId: null, error: null };
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startTime = 0;
  private startedAt = 0;
  private stopped: Promise<Blob> | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(p: Partial<RecorderState>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }

  /** Open the input (for the meter) unless a stream is already live. */
  async ensureOpen() {
    if (!this.stream) await this.open(this.state.deviceId);
  }

  async open(deviceId?: string | null) {
    if (this.state.phase !== "idle") return; // never swap the input under a take
    this.close();
    try {
      this.stream = await microphone(deviceId);
    } catch (e) {
      this.set({ error: `Microphone unavailable: ${(e as Error).message}` });
      throw e;
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const meter = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 10 * Math.log10(sum / buf.length + 1e-12);
      this.set({ levelDb: Math.max(-90, db), elapsed: this.state.phase === "recording" ? (performance.now() - this.startedAt) / 1000 : this.state.elapsed });
      this.raf = requestAnimationFrame(meter);
    };
    this.raf = requestAnimationFrame(meter);
    this.set({ devices, deviceId: deviceId ?? devices[0]?.id ?? null, error: null });
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
  }

  /** Count down, then record. `start` is where the take goes on the timeline. */
  async start(opts: { start?: number; preRollSeconds?: number } = {}) {
    if (this.state.phase !== "idle") throw new Error("Already recording");
    if (!this.stream) await this.open(this.state.deviceId);
    this.startTime = opts.start ?? ui.get().playhead;
    ui.set({ recorder: true });
    for (let n = opts.preRollSeconds ?? 3; n > 0; n--) {
      this.set({ phase: "countdown", count: n });
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.chunks = [];
    const rec = new MediaRecorder(this.stream!, { mimeType: "audio/webm;codecs=opus" });
    this.rec = rec;
    this.stopped = new Promise<Blob>((resolve) => {
      rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      rec.onstop = () => resolve(new Blob(this.chunks, { type: "audio/webm" }));
    });
    rec.start(250);
    this.startedAt = performance.now();
    this.set({ phase: "recording", count: 0, elapsed: 0 });
    return { recording: true, start: this.startTime };
  }

  /** Stop, convert to AAC, import and place on a voiceover lane. */
  async stop(): Promise<{ elementId?: string; path: string; durationSeconds: number }> {
    if (this.state.phase !== "recording" || !this.rec) throw new Error("Not recording");
    this.set({ phase: "saving" });
    this.rec.stop();
    const blob = await this.stopped!;
    if (!blob.size) {
      this.set({ phase: "idle", elapsed: 0 });
      throw new Error("No audio was recorded (check the microphone input)");
    }
    const project = live.state.project!;
    const dir = path.join(WORKSPACE, "projects", project.id, "cache", "recordings");
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `voiceover-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.writeFileSync(`${base}.webm`, Buffer.from(await blob.arrayBuffer()));
    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG, ["-v", "error", "-y", "-i", `${base}.webm`, "-c:a", "aac", "-b:a", "192k", `${base}.m4a`]);
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Could not convert the recording: ${stderr.trim().split("\n").pop() ?? code}`))));
      p.on("error", reject);
    });
    fs.rmSync(`${base}.webm`, { force: true });
    const placed = await live.call<{ elementId: string }>("addMedia", { path: `${base}.m4a`, start: this.startTime, role: "voiceover" });
    const durationSeconds = (performance.now() - this.startedAt) / 1000;
    this.set({ phase: "idle", elapsed: 0 });
    return { elementId: placed.elementId, path: `${base}.m4a`, durationSeconds: Math.round(durationSeconds * 100) / 100 };
  }
}

export const recorder = new VoiceRecorder();

/**
 * The microphone stream. In UI tests (OPENEDITS_UI_TEST=1) a generated 440 Hz tone stands in for
 * the device, since macOS microphone permission cannot be granted headlessly.
 */
let toneContext: AudioContext | null = null; // held so the generator is not garbage-collected mid-take

async function microphone(deviceId?: string | null): Promise<MediaStream> {
  if (process.env.OPENEDITS_UI_TEST === "1") {
    void toneContext?.close();
    const ctx = (toneContext = new AudioContext());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    await ctx.resume();
    return dest.stream;
  }
  if (!(await ipcRenderer.invoke("mic-access"))) throw new Error("Microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone.");
  return navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
}
