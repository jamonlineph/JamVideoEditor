import fs from "node:fs";
import { compositionDuration, evaluateScene, renderContextFor, renderSizeFor, sceneMediaLayers, type Project, type Scene } from "@openedits/core";
import { Compositor, loadSceneFonts } from "@openedits/renderer";
import { MediaManager } from "@openedits/render-host/media";
import { AdaptivePreviewQuality } from "./adaptiveQuality.js";
import { live } from "./live.js";
import { PlaybackAudio } from "./playbackAudio.js";
import { ui } from "./uiStore.js";

const FFMPEG = process.env.OPENEDITS_FFMPEG ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p)) ?? "ffmpeg";
type EditingProxies = Record<string, { path: string; width: number; height: number }>;
type PreviewMode = "interactive" | "playback" | "seek";
type FrameRequest = { time: number; mode: PreviewMode; generation: number; requestedAt: number };
type PlaybackSample = {
  startedAt: number;
  previousTime?: number;
  framesPresented: number;
  framesSkipped: number;
  maxRenderMs: number;
};

function measurePreview(event: string, start: number, end: number, detail: Record<string, number>) {
  const name = `openedits.preview.${event}`;
  performance.clearMeasures(name);
  performance.measure(name, { start, end, detail });
}

/**
 * Live preview: the same scene evaluation and WebGL2 compositor the exporter uses, so what you see
 * is what renders. Drawing is serialized; requests that arrive while a frame is in flight coalesce.
 */
export class Preview {
  readonly compositor: Compositor;
  private media: MediaManager;
  private project: Project | null = null;
  private busy = false;
  private queued?: FrameRequest;
  private generation = 0;
  private preparedProject: Project | null = null;
  private proxies?: EditingProxies;
  private preparedProxies?: EditingProxies;
  androidMediaCodec = false;
  private disposed = false;
  private errorReported = false;
  private playback?: PlaybackSample;
  scene: Scene | null = null;
  readonly quality = new AdaptivePreviewQuality();
  onDrawn?: (scene: Scene) => void;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
    this.media = new MediaManager(this.compositor, { downsizeReaders: true, readerMemoryBytes: 96 * 1024 * 1024 });
  }

  setProject(p: Project | null, proxies?: EditingProxies) {
    this.project = p;
    this.proxies = proxies;
  }

  startPlayback() {
    this.resetPlaybackPosition();
    this.quality.resetSamples();
    this.playback = { startedAt: performance.now(), framesPresented: 0, framesSkipped: 0, maxRenderMs: 0 };
  }

  resetPlaybackPosition() {
    this.generation++;
    this.queued = undefined;
    if (this.playback) this.playback.previousTime = undefined;
  }

  stopPlayback() {
    const sample = this.playback;
    if (!sample) return;
    this.resetPlaybackPosition();
    this.playback = undefined;
    const { framesPresented, framesSkipped, maxRenderMs } = sample;
    measurePreview("playback", sample.startedAt, performance.now(), { framesPresented, framesSkipped, maxRenderMs });
  }

  /** Keep the latest queued frame. A newer seek also supersedes the frame being decoded. */
  async draw(time: number, mode: PreviewMode = "interactive"): Promise<void> {
    if (!this.project || this.disposed) return;
    const generation = mode === "playback" ? this.generation : ++this.generation;
    const request = { time, mode, generation, requestedAt: performance.now() };
    if (this.busy) {
      this.queued = request;
      return;
    }
    await this.render(request);
  }

  private async render(request: FrameRequest): Promise<void> {
    const project = this.project;
    if (!project || this.disposed) return;
    const proxies = this.proxies;
    this.busy = true;
    const started = performance.now();
    const { time, mode, generation, requestedAt } = request;
    try {
      const size = renderSizeFor(project, this.quality.shortSide);
      this.media.setAndroidMediaCodec(this.androidMediaCodec);
      if (project !== this.preparedProject || proxies !== this.preparedProxies) {
        this.media.use(renderContextFor(project, { ffmpeg: FFMPEG, editingProxies: proxies }).ctx);
        this.preparedProject = project;
        this.preparedProxies = proxies;
      }
      const scene = evaluateScene(project, time, size);
      await Promise.all([
        this.media.prepare(sceneMediaLayers(scene), Math.max(size.width, size.height)),
        loadSceneFonts(scene),
      ]);
      if (this.disposed || generation !== this.generation || project !== this.project || proxies !== this.proxies) return;
      this.compositor.render(scene, this.media);
      this.compositor.present();
      this.scene = scene;
      const finished = performance.now();
      if (mode === "playback" && this.playback) {
        const sample = this.playback;
        const fps = project.canvas.fps;
        const skipped = sample.previousTime === undefined ? 0 : Math.max(0, Math.round((time - sample.previousTime) * fps) - 1);
        const queuedAhead = this.queued && (this.queued.time - time) * fps > 1.5;
        const renderMs = finished - started;
        this.quality.observe(renderMs, 1000 / fps, skipped > 0 || !!queuedAhead);
        if (sample.framesPresented === 0) measurePreview("play-start", sample.startedAt, finished, { timeSeconds: time });
        sample.framesPresented++;
        sample.framesSkipped += skipped;
        sample.maxRenderMs = Math.max(sample.maxRenderMs, renderMs);
        sample.previousTime = time;
      } else if (mode === "seek") {
        measurePreview("seek", requestedAt, finished, { timeSeconds: time });
      }
      this.onDrawn?.(scene);
      this.errorReported = false;
    } catch (error) {
      if (!this.disposed && generation === this.generation && !this.errorReported) {
        this.errorReported = true;
        live.toast("error", `Preview: ${(error as Error).message}`);
      }
    } finally {
      this.busy = false;
      if (this.disposed) this.release();
      else if (this.queued) {
        const next = this.queued;
        this.queued = undefined;
        await this.render(next);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.queued = undefined;
    if (!this.busy) this.release();
  }

  private release() {
    this.media.reset();
    this.compositor.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * Playback clock: follows the engine's audio mix when it is ready (so picture stays in sync with
 * sound), otherwise wall-clock time.
 */
export class Player {
  private audio = new PlaybackAudio();
  private raf = 0;
  private startWall = 0;
  private startTime = 0;
  private generation = 0;
  private seekTimer: ReturnType<typeof setTimeout> | undefined;
  private audioWarmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private preview: Preview) {}

  private now(): number {
    return this.audio.time(this.startTime + (performance.now() - this.startWall) / 1000);
  }

  warmPausedAudio() {
    clearTimeout(this.audioWarmTimer);
    this.audioWarmTimer = setTimeout(() => {
      const { project, connected } = live.state;
      if (!project || !connected || ui.get().playing) return;
      const end = compositionDuration(project);
      if (end <= 0) return;
      const time = ui.get().playhead;
      this.audio.warm(project, end, time >= end - 0.05 ? 0 : time);
    }, 350);
  }

  async play(until?: number) {
    const { project } = live.state;
    if (!project || ui.get().playing) return;
    let currentProject = project;
    let end = compositionDuration(project);
    if (end <= 0) return;
    clearTimeout(this.seekTimer);
    clearTimeout(this.audioWarmTimer);
    const generation = ++this.generation;
    let t = ui.get().playhead;
    if (until === undefined && t >= end - 0.05) t = 0;
    this.preview.startPlayback();
    ui.set({ playing: true, playhead: t });
    let lastFrame = Math.floor(t * project.canvas.fps + 1e-6);
    void this.preview.draw(lastFrame / project.canvas.fps, "playback");
    this.audio.configure(project, end);
    await this.audio.prime(t);
    if (generation !== this.generation) return;
    this.startTime = t;
    this.startWall = performance.now();
    this.audio.update(this.audio.time(t));
    const tick = () => {
      if (generation !== this.generation) return;
      const next = live.state.project;
      if (!next || next.id !== project.id) {
        this.dispose();
        return;
      }
      let time = this.now();
      if (next !== currentProject) {
        if (next.canvas.fps !== currentProject.canvas.fps) this.preview.resetPlaybackPosition();
        currentProject = next;
        end = compositionDuration(next);
        lastFrame = -1;
        this.startTime = time;
        this.startWall = performance.now();
        this.audio.configure(next, end);
        time = this.audio.time(time);
      }
      if (until !== undefined && time >= Math.min(until, end)) {
        this.pause(Math.min(until, Math.max(0, end - 1 / currentProject.canvas.fps)));
        return;
      }
      if (time >= end) {
        if (end > 0 && ui.get().loop) {
          time = 0;
          lastFrame = -1;
          this.preview.resetPlaybackPosition();
          this.startTime = 0;
          this.startWall = performance.now();
          this.audio.rewind();
          this.audio.time(0);
        } else {
          this.pause(Math.max(0, end - 1 / currentProject.canvas.fps));
          return;
        }
      }
      this.audio.update(time);
      const frame = Math.floor(time * currentProject.canvas.fps + 1e-6);
      if (frame !== lastFrame) {
        lastFrame = frame;
        const seconds = frame / currentProject.canvas.fps;
        ui.set({ playhead: seconds });
        void this.preview.draw(seconds, "playback");
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(at?: number) {
    this.generation++;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.seekTimer);
    this.audio.stop();
    this.preview.stopPlayback();
    const t = at ?? ui.get().playhead;
    ui.set({ playing: false, playhead: t });
    void live.call("setPlayhead", { seconds: t }).catch(() => {});
  }

  toggle() {
    if (ui.get().playing) this.pause();
    else void this.play();
  }

  /** Move the playhead (pauses playback) and tell the engine where the creator is. */
  seek(t: number) {
    const project = live.state.project;
    const end = project ? compositionDuration(project) : 0;
    const time = Math.max(0, Math.min(t, Math.max(0, end - 1 / (project?.canvas.fps ?? 30))));
    if (ui.get().playing) this.pause(time);
    else {
      ui.set({ playhead: time });
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => void live.call("setPlayhead", { seconds: time }).catch(() => {}), 150);
    }
  }

  dispose() {
    this.generation++;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.seekTimer);
    clearTimeout(this.audioWarmTimer);
    this.audio.dispose();
    this.preview.stopPlayback();
    if (ui.get().playing) ui.set({ playing: false });
  }
}
