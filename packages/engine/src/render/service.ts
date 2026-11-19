import fs from "node:fs";
import path from "node:path";
import { EditError, compositionDuration, fpsExpression, frameTimes, renderContextFor, renderSizeFor, type Project } from "@openedits/core";
import type { EngineHost } from "../host.js";
import type { JobInfo } from "../jobs.js";
import { expandHome, ffmpegEncoders, ffmpegPath, runFfmpeg, videoEncoderArgs, writeWav } from "../ffmpeg.js";
import { renderAudioMix } from "../audio/mix.js";
import { RenderHostClient } from "./hostClient.js";

export interface RenderOutput {
  path: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  sizeBytes: number;
  renderSeconds: number;
  codec: string;
  encoder: string;
  warnings: string[];
}

export interface SheetResult {
  path: string;
  width: number;
  height: number;
  columns: number;
  times: number[];
  warnings: string[];
}

const SHORT_SIDE = { "720p": 720, "1080p": 1080, "4K": 2160 } as const;
const BITRATE_1080P30 = { low: 5e6, medium: 8e6, high: 12e6, max: 24e6 } as const;
const FAST_PRESET_HEIGHT = { "fast-720p": 720, "fast-1080p": 1080 } as const;

async function androidFastEncoder(width: number, height: number, fps: number, bitrate: number, signal: AbortSignal) {
  const names = process.env.OPENEDITS_ANDROID_AVC_ENCODERS?.split(",").filter(Boolean);
  const encoder = "h264_mediacodec";
  if (!names?.length || process.env.OPENEDITS_NO_HWACCEL || !ffmpegEncoders().has(encoder)) return;
  // The device may expose an encoder that rejects this resolution, rotation or buffer format.
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
  for (const name of names) {
    if (probeSignal.aborted) break;
    const args = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=nv12", "-c:v", encoder, "-ndk_codec", "1", "-codec_name", name, "-b:v", String(bitrate)];
    try {
      const probe = await runFfmpeg(["-v", "error", "-f", "lavfi", "-i", `color=s=${width}x${height}:r=${fps}`, "-frames:v", "2", ...args, "-f", "h264", "-"], { signal: probeSignal, collectStdout: true });
      if (probe.stdout.length) return { encoder, args };
    } catch {
      signal.throwIfAborted();
    }
  }
}

function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n}).${ext}`);
  return candidate;
}

async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    }),
  );
}

/** Frame server and exporter: drives the compositor in the render host and FFmpeg encoders. */
export class RenderService {
  private client = new RenderHostClient();
  private counter = 0;

  constructor(private readonly host: EngineHost) {}

  private cacheDir(sub: string): string {
    const dir = path.join(this.host.projectDirPath, "cache", sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private stamp() {
    return `${Date.now().toString(36)}${(++this.counter).toString(36)}`;
  }

  /** Everything the render host needs to draw this project, plus warnings about sources it cannot show faithfully. */
  private context(project: Project, opts: { hideCaptions?: boolean } = {}) {
    return renderContextFor(project, { ffmpeg: ffmpegPath(), hideCaptions: opts.hideCaptions, ...(process.env.OPENEDITS_NO_HWACCEL ? { hwaccel: false } : {}) });
  }

  private clampTime(project: Project, t: number): number {
    const duration = compositionDuration(project);
    return Math.max(0, Math.min(t, Math.max(0, duration - 0.5 / project.canvas.fps)));
  }

  /** Render one composited frame of the timeline to an image file. */
  async captureFrame(opts: { timeSeconds?: number; shortSide?: number; format?: "jpeg" | "png" } = {}) {
    const project = this.host.project;
    const time = this.clampTime(project, opts.timeSeconds ?? this.host.appState.playheadSeconds);
    const size = renderSizeFor(project, opts.shortSide ?? 540);
    const format = opts.format ?? "jpeg";
    const out = path.join(this.cacheDir("frames"), `frame-${this.stamp()}.${format === "png" ? "png" : "jpg"}`);
    const { ctx, warnings } = this.context(project);
    const r = await this.client.request<{ warnings: string[] }>("renderFrames", { ctx, times: [time], width: size.width, height: size.height, outputs: [out], format, quality: 0.88 });
    return { path: out, ...size, timeSeconds: time, warnings: [...warnings, ...r.warnings] };
  }

  /** Contact sheet of composited frames across a time range. */
  async frameSheet(opts: { startSeconds?: number; endSeconds?: number; count?: number; times?: number[]; columns?: number; tileShortSide?: number } = {}): Promise<SheetResult> {
    const project = this.host.project;
    const duration = compositionDuration(project);
    if (duration <= 0) throw new EditError("INVALID_RANGE", "The timeline is empty");
    const start = Math.max(0, opts.startSeconds ?? 0);
    const end = Math.min(duration, opts.endSeconds ?? duration);
    if (end <= start) throw new EditError("INVALID_RANGE", `Range ${start}..${end}s is empty (timeline is ${duration.toFixed(3)}s)`);
    const count = Math.max(1, Math.min(48, opts.count ?? 12));
    const times = (opts.times?.length ? opts.times.slice(0, 48) : Array.from({ length: count }, (_, i) => start + ((i + 0.5) * (end - start)) / count)).map((t) => this.clampTime(project, t));
    const tile = renderSizeFor(project, opts.tileShortSide ?? 216);
    const columns = Math.max(1, Math.min(times.length, opts.columns ?? (tile.width > tile.height ? 4 : 6)));
    const out = path.join(this.cacheDir("frames"), `sheet-${this.stamp()}.jpg`);
    const { ctx, warnings } = this.context(project);
    const r = await this.client.request<{ width: number; height: number; warnings: string[] }>("renderSheet", {
      ctx,
      times,
      labels: times.map((t) => `${t.toFixed(2)}s`),
      tileWidth: tile.width,
      tileHeight: tile.height,
      columns,
      output: out,
    });
    return { path: out, width: r.width, height: r.height, columns, times, warnings: [...warnings, ...r.warnings] };
  }

  /** Contact sheet of frames taken straight from a media file (no timeline effects). Times are source seconds. */
  async sourceFrames(opts: { mediaId?: string; path?: string; timesSourceSeconds?: number[]; count?: number; startSourceSeconds?: number; endSourceSeconds?: number; columns?: number; tileShortSide?: number; label?: string }): Promise<SheetResult & { name: string; kind: string; durationSourceSeconds?: number }> {
    let file: string;
    let name: string;
    let kind: string;
    let width: number | undefined;
    let height: number | undefined;
    let duration: number | undefined;
    if (opts.mediaId) {
      const m = this.host.project.media[opts.mediaId];
      if (!m) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${opts.mediaId}"`);
      ({ path: file, name, kind, width, height, durationSourceSeconds: duration } = m);
    } else if (opts.path) {
      file = path.resolve(expandHome(opts.path));
      const probe = await this.host.prober(file);
      name = path.basename(file);
      ({ kind, width, height, durationSourceSeconds: duration } = probe);
    } else throw new EditError("INVALID_ARGUMENT", "Provide mediaId or path");
    if (kind === "audio" || !width || !height) throw new EditError("UNSUPPORTED_MEDIA", `${name} has no picture to show`);
    if (!fs.existsSync(file)) throw new EditError("FILE_NOT_FOUND", `File not found: ${file}`, { path: file });

    const short = opts.tileShortSide ?? (kind === "image" ? 540 : 216);
    const s = short / Math.min(width, height);
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const tile = { width: even(width * s), height: even(height * s) };
    let times: number[];
    if (kind === "image") times = [0];
    else {
      const total = duration ?? 0;
      const start = Math.max(0, opts.startSourceSeconds ?? 0);
      const end = Math.min(total, opts.endSourceSeconds ?? total);
      const count = Math.max(1, Math.min(48, opts.count ?? 12));
      times = (opts.timesSourceSeconds?.length ? opts.timesSourceSeconds.slice(0, 48) : Array.from({ length: count }, (_, i) => start + ((i + 0.5) * (end - start)) / count)).map((t) => Math.max(0, Math.min(t, Math.max(0, total - 0.05))));
    }
    const dir = this.host.isOpen ? this.cacheDir("frames") : fs.mkdtempSync(path.join(this.host.paths.cache, "frames-"));
    const stamp = this.stamp();
    const tiles = times.map((t, i) => ({ path: path.join(dir, `src-${stamp}-${i}.jpg`), label: kind === "image" ? "" : `${t.toFixed(2)}s` }));
    await pool(times, 4, async (t, i) => {
      const args = ["-v", "error", "-y"];
      if (kind !== "image" && t > 0) args.push("-ss", t.toFixed(4));
      args.push("-i", file, "-frames:v", "1", "-vf", `scale=${tile.width}:${tile.height}`, "-q:v", "4", tiles[i].path);
      await runFfmpeg(args).catch(() => undefined); // a missing tile is drawn as an empty cell
    });
    const columns = Math.max(1, Math.min(times.length, opts.columns ?? (tile.width > tile.height ? 4 : 6)));
    const out = path.join(dir, `source-sheet-${stamp}.jpg`);
    const r = await this.client.request<{ width: number; height: number }>("composeSheet", { tiles, columns, tileWidth: tile.width, tileHeight: tile.height, output: out });
    for (const t of tiles) fs.rmSync(t.path, { force: true });
    return { path: out, width: r.width, height: r.height, columns, times, warnings: [], name, kind, ...(duration !== undefined ? { durationSourceSeconds: duration } : {}) };
  }

  /** Start rendering the timeline to a video file. Returns a job to poll or wait on. */
  startRender(opts: { mode: "preview" | "export"; preset?: keyof typeof FAST_PRESET_HEIGHT; startSeconds?: number; endSeconds?: number; shortSide?: number; fps?: number; outputPath?: string }): JobInfo {
    const host = this.host;
    const project = host.project; // immutable snapshot: later edits do not affect this render
    const settings = project.exportSettings;
    const preview = opts.mode === "preview";
    const preset = preview ? undefined : opts.preset;
    const fps = preset ? 30 : opts.fps ?? (preview ? Math.min(project.canvas.fps, 30) : settings.fps);
    const times = frameTimes(project, { startSeconds: opts.startSeconds, endSeconds: opts.endSeconds }, fps);
    if (!times.length) throw new EditError("INVALID_RANGE", "Nothing to render: the timeline (or the requested range) is empty");
    const size = renderSizeFor(project, preset ? FAST_PRESET_HEIGHT[preset] : opts.shortSide ?? (preview ? 540 : SHORT_SIDE[settings.resolution]));
    const codec = preview || preset ? "h264" : settings.codec;
    const container = codec === "prores" ? "mov" : preview || preset ? "mp4" : settings.container;
    const quality = preview ? "low" : settings.quality;
    const scale = ((size.width * size.height) / (1080 * 1920)) * Math.pow(fps / 30, 0.75);
    const bitrate = Math.round(Math.max(600e3, BITRATE_1080P30[quality] * scale * (codec === "hevc" ? 0.65 : 1) * (preview ? 1.6 : 1)));
    const safeName = (settings.fileName ?? project.name).replace(/[\\/:*?"<>|]+/g, " ").trim() || "export";
    let out = opts.outputPath;
    if (!out) {
      if (preview) out = path.join(this.cacheDir("previews"), `preview-${this.stamp()}.mp4`);
      else {
        const dir = settings.outputDir ?? host.paths.outbox;
        fs.mkdirSync(dir, { recursive: true });
        out = uniquePath(dir, safeName, container);
      }
    }
    const output = out;
    const start = times[0];
    const durationSeconds = times.length / fps;
    const audioDir = this.cacheDir("audio");
    const { ctx, warnings } = this.context(project, { hideCaptions: !preview && !settings.burnInCaptions });

    return host.jobs.start(opts.mode, async (job) => {
      const wav = path.join(audioDir, `mix-${this.stamp()}.wav`);
      // Write the partial render to a private directory so cancellation or a failed encoder
      // cannot remove or replace an existing export.
      const staging = fs.mkdtempSync(path.join(path.dirname(output), ".openedits-render-"));
      try {
        job.progress(0.01, "Mixing audio");
        {
          const mix = await renderAudioMix(project, { startSeconds: start, endSeconds: start + durationSeconds, signal: job.signal });
          job.signal.throwIfAborted();
          writeWav(wav, mix.samples, mix.sampleRate, 2);
          warnings.push(...mix.warnings);
        }
        const partial = path.join(staging, `video.${container}`);
        const audio = codec === "prores" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", `${preview ? 128 : settings.audioBitrateKbps}k`];
        const render = (video: { encoder: string; args: string[] }) => {
          const ffmpegArgs = [
            "-v", "error", "-y", "-nostdin",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${size.width}x${size.height}`, "-r", String(fps), "-i", "-",
            "-i", wav,
            "-map", "0:v", "-map", "1:a",
            ...video.args,
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
            ...audio,
            "-t", durationSeconds.toFixed(6),
            ...(container === "mp4" ? ["-movflags", "+faststart"] : []),
            partial,
          ];
          return this.client.request<{ frames: number; seconds: number; warnings: string[] }>(
            "renderVideo",
            { ctx, times, width: size.width, height: size.height, ffmpegArgs },
            {
              signal: job.signal,
              onProgress: (p) => job.progress(0.05 + 0.95 * (Number(p.frame) / Number(p.total)), `${p.frame}/${p.total} frames (${Number(p.fps).toFixed(0)} fps)`),
            },
          );
        };
        const hardware = preset ? await androidFastEncoder(size.width, size.height, fps, bitrate, job.signal) : undefined;
        const software = () => videoEncoderArgs(codec, bitrate, { fast: preview || !!preset });
        let video = hardware ?? software();
        const r = await render(video).catch((error: unknown) => {
          job.signal.throwIfAborted();
          if (!hardware) throw error;
          warnings.push("Android's hardware encoder failed. The export was encoded in software.");
          job.progress(0.05, "Retrying with the software encoder");
          video = software();
          return render(video);
        });
        job.signal.throwIfAborted();
        const sizeBytes = fs.statSync(partial).size;
        const destination = !preview && !opts.outputPath ? uniquePath(path.dirname(output), safeName, container) : output;
        fs.renameSync(partial, destination);
        const result: RenderOutput = {
          path: destination,
          ...size,
          fps,
          frames: r.frames,
          durationSeconds,
          sizeBytes,
          renderSeconds: Math.round(r.seconds * 100) / 100,
          codec,
          encoder: video.encoder,
          warnings: [...new Set([...warnings, ...r.warnings])],
        };
        return result;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(wav, { force: true });
      }
    }, { projectId: host.projectId });
  }

  async ping() {
    return this.client.request<{ ok: boolean; renderer: string; maxTextureSize: number }>("ping", {});
  }

  dispose() {
    this.client.dispose();
  }
}

export { fpsExpression };
