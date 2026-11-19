import fs from "node:fs";
import { compositionDuration, evaluateScene, renderContextFor, renderSizeFor, sceneMediaLayers, type Project, type Scene } from "@openedits/core";
import { Compositor } from "@openedits/renderer";
import { MediaManager } from "@openedits/render-host/media";
import { AdaptivePreviewQuality } from "./adaptiveQuality.js";
import { live } from "./live.js";
import { PlaybackAudio } from "./playbackAudio.js";
import { ui } from "./uiStore.js";

const FFMPEG = process.env.OPENEDITS_FFMPEG ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p)) ?? "ffmpeg";
type EditingProxies = Record<string, { path: string; width: number; height: number }>;

/**
 * Live preview: the same scene evaluation and WebGL2 compositor the exporter uses, so what you see
 * is what renders. Drawing is serialized; requests that arrive while a frame is in flight coalesce.
 */
export class Preview {
  readonly compositor: Compositor;
  private media: MediaManager;
  private project: Project | null = null;
  private busy = false;
  private queued: number | null = null;
  private preparedProject: Project | null = null;
  private proxies?: EditingProxies;
  private preparedProxies?: EditingProxies;
  androidMediaCodec = false;
  private disposed = false;
  private errorReported = false;
  private lastPlaybackFrame: { projectId: string; time: number } | undefined;
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

  /** Draw the frame at `time`; returns when it is on screen (or skipped in favor of a newer request). */
  async draw(time: number): Promise<void> {
    if (!this.project || this.disposed) return;
    if (this.busy) {
      this.queued = time;
      return;
    }
    this.busy = true;
    const started = performance.now();
    const playing = ui.get().playing;
    try {
      const project = this.project;
      const size = renderSizeFor(project, this.quality.shortSide);
      this.media.setAndroidMediaCodec(this.androidMediaCodec);
      if (project !== this.preparedProject || this.proxies !== this.preparedProxies) {
        this.media.use(renderContextFor(project, { ffmpeg: FFMPEG, editingProxies: this.proxies }).ctx);
        this.preparedProject = project;
        this.preparedProxies = this.proxies;
      }
      const scene = evaluateScene(project, time, size);
      await this.media.prepare(sceneMediaLayers(scene), Math.max(size.width, size.height));
      if (this.disposed) return;
      this.compositor.render(scene, this.media);
      this.compositor.present();
      this.scene = scene;
      if (playing && ui.get().playing && project === this.project) {
        const previous = this.lastPlaybackFrame;
        const skipped = (previous?.projectId === project.id && (time - previous.time) * project.canvas.fps > 1.5)
          || (this.queued !== null && (this.queued - time) * project.canvas.fps > 1.5);
        this.quality.observe(performance.now() - started, 1000 / project.canvas.fps, skipped);
        this.lastPlaybackFrame = { projectId: project.id, time };
      } else {
        this.lastPlaybackFrame = undefined;
        this.quality.resetSamples();
      }
      this.onDrawn?.(scene);
      this.errorReported = false;
    } catch (error) {
      if (!this.disposed && !this.errorReported) {
        this.errorReported = true;
        live.toast("error", `Preview: ${(error as Error).message}`);
      }
    } finally {
      this.busy = false;
      if (this.disposed) this.release();
    }
    if (this.queued !== null) {
      const next = this.queued;
      this.queued = null;
      await this.draw(next);
    }
  }

  dispose() {
    this.disposed = true;
    this.queued = null;
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

  constructor(private preview: Preview) {}

  private now(): number {
    return this.audio.time(this.startTime + (performance.now() - this.startWall) / 1000);
  }

  async play() {
    const { project } = live.state;
    if (!project || ui.get().playing) return;
    let currentProject = project;
    let end = compositionDuration(project);
    if (end <= 0) return;
    clearTimeout(this.seekTimer);
    const generation = ++this.generation;
    let t = ui.get().playhead;
    if (t >= end - 0.05) t = 0;
    ui.set({ playing: true, playhead: t });
    this.audio.configure(project, end);
    await this.audio.prime(t);
    if (generation !== this.generation) return;
    this.startTime = t;
    this.startWall = performance.now();
    this.audio.update(this.audio.time(t));
    let lastFrame = -1;
    const tick = () => {
      if (generation !== this.generation) return;
      const next = live.state.project;
      if (!next || next.id !== project.id) {
        this.dispose();
        return;
      }
      let time = this.now();
      if (next !== currentProject) {
        currentProject = next;
        end = compositionDuration(next);
        lastFrame = -1;
        this.startTime = time;
        this.startWall = performance.now();
        this.audio.configure(next, end);
        time = this.audio.time(time);
      }
      if (time >= end) {
        if (end > 0 && ui.get().loop) {
          time = 0;
          lastFrame = -1;
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
        void this.preview.draw(seconds);
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
    this.audio.dispose();
    if (ui.get().playing) ui.set({ playing: false });
  }
}
