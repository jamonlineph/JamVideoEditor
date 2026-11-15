import fs from "node:fs";
import { compositionDuration, evaluateScene, renderContextFor, renderSizeFor, sceneMediaLayers, type Project, type Scene } from "@openedits/core";
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
  scene: Scene | null = null;
  shortSide = 720;
  onDrawn?: (scene: Scene) => void;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
    this.media = new MediaManager(this.compositor);
  }

  setProject(p: Project | null) {
    this.project = p;
  }

  /** Draw the frame at `time`; returns when it is on screen (or skipped in favor of a newer request). */
  async draw(time: number): Promise<void> {
    if (!this.project) return;
    if (this.busy) {
      this.queued = time;
      return;
    }
    this.busy = true;
    try {
      const project = this.project;
      const size = renderSizeFor(project, this.shortSide);
      const { ctx } = renderContextFor(project, { ffmpeg: FFMPEG });
      this.media.use(ctx);
      const scene = evaluateScene(project, time, size);
      await this.media.prepare(sceneMediaLayers(scene));
      this.compositor.render(scene, this.media);
      this.compositor.present();
      this.scene = scene;
      this.onDrawn?.(scene);
    } finally {
      this.busy = false;
    }
    if (this.queued !== null) {
      const next = this.queued;
      this.queued = null;
      await this.draw(next);
    }
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

  constructor(private preview: Preview) {
    this.audio.preload = "auto";
  }

  private async prepareAudio() {
    const s = live.state;
    if (!s.project || s.version === this.mixVersion) return;
    const r = await live.call<{ path: string; version: number }>("previewAudio").catch(() => null);
    if (!r) return;
    this.mixVersion = r.version;
    if (r.path !== this.mixPath) {
      this.mixPath = r.path;
      this.audio.src = fileUrl(r.path);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.audio.addEventListener("canplay", done, { once: true });
        this.audio.addEventListener("error", done, { once: true });
        setTimeout(done, 3000);
      });
    }
  }

  private now(): number {
    if (this.mixPath && !this.audio.paused && this.audio.readyState >= 2) return this.audio.currentTime;
    return this.startTime + (performance.now() - this.startWall) / 1000;
  }

  async play() {
    const project = live.state.project;
    if (!project) return;
    const end = compositionDuration(project);
    if (end <= 0) return;
    let t = ui.get().playhead;
    if (t >= end - 0.05) t = 0;
    ui.set({ playing: true, playhead: t });
    await this.prepareAudio();
    if (!ui.get().playing) return;
    this.startTime = t;
    this.startWall = performance.now();
    if (this.mixPath) {
      this.audio.currentTime = t;
      await this.audio.play().catch(() => {});
    }
    const tick = () => {
      if (!ui.get().playing) return;
      const cur = live.state.project ? compositionDuration(live.state.project) : 0;
      let time = this.now();
      if (time >= cur) {
        if (ui.get().loop) {
          time = 0;
          this.startTime = 0;
          this.startWall = performance.now();
          if (this.mixPath) this.audio.currentTime = 0;
        } else {
          this.pause(cur);
          return;
        }
      }
      ui.set({ playhead: time });
      void this.preview.draw(time);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(at?: number) {
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    const t = at ?? ui.get().playhead;
    ui.set({ playing: false, playhead: t });
    void live.call("setPlayhead", { seconds: t }).catch(() => {});
    void this.preview.draw(t);
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
      void this.preview.draw(time);
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => void live.call("setPlayhead", { seconds: time }).catch(() => {}), 150);
    }
  }
  private seekTimer: ReturnType<typeof setTimeout> | undefined;
}
