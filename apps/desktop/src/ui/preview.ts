import fs from "node:fs";
import { buildAudioPlan, compositionDuration, evaluateScene, renderContextFor, renderSizeFor, sceneMediaLayers, type Project, type Scene } from "@openedits/core";
import { Compositor } from "@openedits/renderer";
import { MediaManager } from "@openedits/render-host/media";
import { fileUrl, live } from "./live.js";
import { ui } from "./uiStore.js";

const FFMPEG = process.env.OPENEDITS_FFMPEG ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p)) ?? "ffmpeg";

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
  private disposed = false;
  private errorReported = false;
  scene: Scene | null = null;
  shortSide = 720;
  onDrawn?: (scene: Scene) => void;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
    this.media = new MediaManager(this.compositor, { downsizeReaders: true });
  }

  setProject(p: Project | null) {
    this.project = p;
  }

  /** Draw the frame at `time`; returns when it is on screen (or skipped in favor of a newer request). */
  async draw(time: number): Promise<void> {
    if (!this.project || this.disposed) return;
    if (this.busy) {
      this.queued = time;
      return;
    }
    this.busy = true;
    try {
      const project = this.project;
      const size = renderSizeFor(project, this.shortSide);
      if (project !== this.preparedProject) {
        this.media.use(renderContextFor(project, { ffmpeg: FFMPEG }).ctx);
        this.preparedProject = project;
      }
      const scene = evaluateScene(project, time, size);
      await this.media.prepare(sceneMediaLayers(scene));
      if (this.disposed) return;
      this.compositor.render(scene, this.media);
      this.compositor.present();
      this.scene = scene;
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
  private audio = new Audio();
  private raf = 0;
  private startWall = 0;
  private startTime = 0;
  private mixVersion = -1;
  private mixPath = "";
  private mixRequest: { version: number; promise: Promise<{ path: string; version: number } | null> } | undefined;
  private generation = 0;
  private seekTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private preview: Preview) {
    this.audio.preload = "auto";
  }

  private async prepareAudio(generation: number, project: Project, version: number) {
    if (version === this.mixVersion) return;
    if (buildAudioPlan(project).length === 0) {
      this.mixVersion = version;
      this.mixPath = "";
      return;
    }
    if (this.mixRequest?.version !== version) {
      this.mixRequest = { version, promise: live.call<{ path: string; version: number }>("previewAudio").catch(() => null) };
    }
    const request = this.mixRequest;
    const r = await request.promise;
    if (this.mixRequest === request) this.mixRequest = undefined;
    if (generation !== this.generation) return;
    if (!r || r.version !== live.state.version) {
      this.mixPath = "";
      this.mixVersion = -1;
      return;
    }
    this.mixVersion = r.version;
    if (r.path !== this.mixPath) {
      this.mixPath = r.path;
      this.audio.src = fileUrl(r.path);
    }
  }

  private now(): number {
    if (this.mixPath && !this.audio.paused && this.audio.readyState >= 2) return this.audio.currentTime;
    return this.startTime + (performance.now() - this.startWall) / 1000;
  }

  async play() {
    const { project, version } = live.state;
    if (!project || ui.get().playing) return;
    let currentProject = project;
    let end = compositionDuration(project);
    if (end <= 0) return;
    clearTimeout(this.seekTimer);
    const generation = ++this.generation;
    let t = ui.get().playhead;
    if (t >= end - 0.05) t = 0;
    ui.set({ playing: true, playhead: t });
    await this.prepareAudio(generation, project, version);
    if (generation !== this.generation) return;
    this.startTime = t;
    this.startWall = performance.now();
    if (this.mixPath) {
      this.audio.currentTime = t;
      // Let the media clock take over once it starts. A slow load must not stall video playback.
      void this.audio.play().then(() => {
        if (generation === this.generation) this.audio.currentTime = Math.min(this.audio.duration || end, this.startTime + (performance.now() - this.startWall) / 1000);
      }).catch(() => {});
    }
    let lastFrame = -1;
    const tick = () => {
      if (generation !== this.generation) return;
      const next = live.state.project;
      if (!next || next.id !== project.id) return;
      if (next !== currentProject) {
        currentProject = next;
        end = compositionDuration(next);
        lastFrame = -1;
      }
      let time = this.now();
      if (time >= end) {
        if (end > 0 && ui.get().loop) {
          time = 0;
          lastFrame = -1;
          this.startTime = 0;
          this.startWall = performance.now();
          if (this.mixPath) {
            this.audio.currentTime = 0;
            void this.audio.play().catch(() => {});
          }
        } else {
          this.pause(Math.max(0, end - 1 / currentProject.canvas.fps));
          return;
        }
      }
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
    this.audio.pause();
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
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (ui.get().playing) ui.set({ playing: false });
  }
}
