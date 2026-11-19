import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { builtinLut, type MediaLayer, type MediaRenderInfo as MediaInfo, type RenderContext } from "@openedits/core";
import { parseCube, type Compositor, type LutTexture, type SceneResources, type TextureInfo } from "@openedits/renderer";

export const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
const DEFAULT_READER_MEMORY = 192 * 1024 * 1024;
const TIME_EPSILON = 0.000002;
const MEDIACODEC_TIMEOUT_MS = 2000;
type TimedFrame = { time: number; id: number; pixels: Uint8Array };
type AndroidDecoder = "h264_mediacodec" | "hevc_mediacodec";

/** Sequential raw-frame reader over an ffmpeg pipe, with a chunk cache for backwards playback. */
export class VideoReader {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = true;
  private wake: (() => void) | null = null;
  private frameId = 0;
  private firstFrameId = 0;
  private timestamps: number[] = [];
  private frames: TimedFrame[] = [];
  private seekSeconds = 0;
  private memoryBytes = DEFAULT_READER_MEMORY;
  private uploadedId = -1;
  private decoderError: Error | undefined;
  texture: TextureInfo | null = null;
  lastUsed = 0;
  readonly frameBytes: number;

  constructor(private compositor: Compositor, private ctx: RenderContext, private info: MediaInfo, readonly width: number, readonly height: number, readonly decoder?: AndroidDecoder) {
    this.frameBytes = width * height * 4;
  }

  get sourcePath() {
    return this.info.path;
  }

  private get prefetchFrames() {
    // Each active reader already needs a texture and its current frame.
    return Math.max(1, Math.min(2, Math.floor(this.memoryBytes / this.frameBytes) - 2));
  }

  get reverseCacheFrames() {
    const available = Math.floor(this.memoryBytes / this.frameBytes) - this.prefetchFrames - 2;
    return Math.max(1, Math.min(60, available));
  }

  configureMemory(bytes: number) {
    if (bytes === this.memoryBytes) return;
    this.memoryBytes = bytes;
    if (this.frames.length > this.reverseCacheFrames) this.frames = this.frames.slice(-this.reverseCacheFrames);
    if (this.buffered > this.frameBytes * this.prefetchFrames) this.stop();
  }

  /** Drop unused decoders and CPU buffers immediately. The manager can retain the last GPU texture. */
  idle() {
    this.stop();
    this.frames = [];
  }

  private start(seconds: number) {
    this.idle();
    this.decoderError = undefined;
    this.seekSeconds = seconds;
    this.firstFrameId = this.frameId + 1;
    const proxy = this.info.editingProxy?.path === this.info.path;
    const args = ["-hide_banner", "-nostats", "-loglevel", "info", "-nostdin", "-copyts"];
    // Proxies already carry timestamps in the original file's timeline. Rebasing a video-only
    // proxy to zero would remove any lead-in where the original file contained only audio.
    if (!proxy) args.push("-start_at_zero");
    if (this.decoder) args.push("-c:v", this.decoder, "-ndk_codec", "1");
    else if (this.ctx.hwaccel !== false && process.platform === "darwin") args.push("-hwaccel", "videotoolbox");
    // Keep the keyframe and the intervening frames so a seek into a VFR gap can use its preceding frame.
    if (seconds > 0) {
      if (proxy) args.push("-seek_timestamp", "1");
      args.push("-ss", seconds.toFixed(6), "-noaccurate_seek");
    }
    const scale = `scale=${this.width}:${this.height}:flags=bilinear${this.info.inColorMatrix ? `:in_color_matrix=${this.info.inColorMatrix}` : ""}`;
    args.push("-i", this.info.path, "-map", "0:V:0", "-an", "-sn", "-dn", "-vf", `${scale},showinfo=checksum=0`, "-fps_mode", "passthrough", "-pix_fmt", "rgba", "-threads", "1", "-f", "rawvideo", "-");
    const proc = spawn(this.ctx.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    proc.stdout!.on("data", (d: Buffer) => {
      if (this.proc !== proc) return;
      this.chunks.push(d);
      this.buffered += d.length;
      if (this.buffered >= this.frameBytes * this.prefetchFrames) proc.stdout!.pause();
      this.wake?.();
    });
    let stderr = "";
    let timeBase = 0;
    proc.stderr!.on("data", (data: Buffer | string) => {
      if (this.proc !== proc) return;
      const lines = (stderr + data.toString()).split("\n");
      stderr = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes("Parsed_showinfo_")) continue;
        const base = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
        if (base) timeBase = Number(base[1]) / Number(base[2]);
        const pts = /\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:/.exec(line);
        if (pts && timeBase) this.timestamps.push(Number(pts[1]) * timeBase);
      }
      this.wake?.();
    });
    const finish = (error?: Error) => {
      if (this.proc !== proc) return;
      if (this.decoder) this.decoderError = error;
      this.ended = true;
      this.wake?.();
    };
    proc.on("close", (code) => finish(code === 0 ? undefined : new Error(`${this.decoder ?? "FFmpeg"} stopped (${code})`)));
    proc.on("error", finish);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ended = true;
    this.chunks = [];
    this.buffered = 0;
    this.timestamps = [];
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    this.wake?.();
  }

  /** Next frame in decode order, or null at the end of the stream. */
  private async read(): Promise<Uint8Array | null> {
    while (this.buffered < this.frameBytes && !this.ended) {
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
    if (this.buffered < this.frameBytes) return null;
    const frame = new Uint8Array(this.frameBytes);
    let filled = 0;
    while (filled < this.frameBytes) {
      const head = this.chunks[0];
      const take = Math.min(head.length, this.frameBytes - filled);
      frame.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= this.frameBytes;
    if (this.buffered < this.frameBytes * this.prefetchFrames) this.proc?.stdout?.resume();
    return frame;
  }

  private async decodeThrough(target: number): Promise<TimedFrame | undefined> {
    for (;;) {
      // showinfo reports the timestamp before the matching raw frame reaches stdout.
      while (!this.timestamps.length && !this.ended) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
      }
      if (this.decoderError) throw this.decoderError;
      const time = this.timestamps[0];
      if (time === undefined || (this.frames.length && time > target)) return this.frames.at(-1);
      // A seek can return a frame after the target if the demuxer has no earlier seek point.
      if (this.seekSeconds > 0 && time > target) return;
      const pixels = await this.read();
      if (this.decoderError) throw this.decoderError;
      if (!pixels) return this.frames.at(-1);
      this.timestamps.shift();
      this.frames.push({ time, pixels, id: ++this.frameId });
      if (this.frames.length > this.reverseCacheFrames) this.frames.shift();
    }
  }

  private async frameAt(seconds: number, before: boolean): Promise<TimedFrame | undefined> {
    const target = seconds + (before ? -TIME_EPSILON : TIME_EPSILON);
    const first = this.frames[0];
    const last = this.frames.at(-1);
    if (first && target < first.time && this.seekSeconds === 0 && first.id === this.firstFrameId) return first;
    if (first && last && first.time <= target && target < last.time) {
      return this.frames.findLast((frame) => frame.time <= target);
    }
    const next = this.timestamps[0];
    const jumpingForward = last && target - last.time > 2 && next !== undefined && next < target - 2;
    if (!this.proc || (first && target < first.time) || jumpingForward) {
      const lead = before || (first && target < first.time) ? (this.reverseCacheFrames - 1) / this.info.fps : 0;
      this.start(Math.max(0, target - lead));
    }
    const frame = await this.decodeThrough(target);
    if (frame || this.seekSeconds === 0) return frame;
    this.start(0);
    return this.decodeThrough(target);
  }

  async textureAt(seconds: number, before = false): Promise<TextureInfo | null> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (this.decoder) {
      timeout = setTimeout(() => {
        this.decoderError = new Error(`${this.decoder} timed out waiting for a frame`);
        this.stop();
      }, MEDIACODEC_TIMEOUT_MS);
    }
    const frame = await this.frameAt(Math.max(0, seconds), before).finally(() => clearTimeout(timeout));
    if (!frame) return null;
    if (!this.texture || this.uploadedId !== frame.id) {
      this.texture = this.compositor.uploadPixels(this.texture, frame.pixels, this.width, this.height);
      this.uploadedId = frame.id;
    }
    return this.texture;
  }

  dispose() {
    this.idle();
    this.compositor.deleteTexture(this.texture);
    this.texture = null;
  }
}

export function collect(proc: ChildProcess): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout!.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim().split("\n").pop() || `ffmpeg exited with ${code}`))));
  });
}

/** Decodes the frames, masks and LUTs a scene needs and hands them to the compositor. */
export class MediaManager implements SceneResources {
  private readers = new Map<string, VideoReader>();
  private images = new Map<string, TextureInfo>();
  private unavailableProxies = new Set<string>();
  private unavailableAndroidDecoders = new Set<string>();
  private androidMediaCodec = false;
  private luts = new Map<string, LutTexture | null>();
  private frameTextures = new Map<string, TextureInfo>();
  private maskTextures = new Map<string, TextureInfo>();
  private tick = 0;
  ctx!: RenderContext;
  private signature = "";

  constructor(private compositor: Compositor, private options: { downsizeReaders?: boolean; readerMemoryBytes?: number } = {}) {}

  setAndroidMediaCodec(enabled: boolean) {
    this.androidMediaCodec = enabled && !!this.options.downsizeReaders;
  }

  /** Reset caches when the set of media files changes. */
  use(ctx: RenderContext) {
    const sig = JSON.stringify([Object.entries(ctx.media).map(([id, m]) => [id, m.path, m.width, m.height, m.videoCodec, m.colorTransfer, m.editingProxy?.path]), ctx.luts]);
    if (sig !== this.signature) this.reset();
    this.signature = sig;
    this.ctx = ctx;
  }

  reset() {
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
    this.unavailableProxies.clear();
    this.unavailableAndroidDecoders.clear();
    this.frameTextures.clear();
    this.maskTextures.clear();
    for (const t of this.images.values()) this.compositor.deleteTexture(t);
    this.images.clear();
    for (const lut of this.luts.values()) if (lut) this.compositor.gl.deleteTexture(lut.tex);
    this.luts.clear();
  }

  private async image(mediaId: string, info: MediaInfo): Promise<TextureInfo | null> {
    const hit = this.images.get(mediaId);
    if (hit) return hit;
    const cap = Math.min(1, 4096 / Math.max(info.width, info.height));
    const w = even(info.width * cap);
    const h = even(info.height * cap);
    const proc = spawn(this.ctx.ffmpeg, ["-v", "error", "-nostdin", "-i", info.path, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-pix_fmt", "rgba", "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const data = await collect(proc);
    if (data.length < w * h * 4) return null;
    // Straight alpha from the file -> premultiplied for the compositor.
    const px = new Uint8Array(data.buffer, data.byteOffset, w * h * 4);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a !== 255) {
        px[i] = (px[i] * a) / 255;
        px[i + 1] = (px[i + 1] * a) / 255;
        px[i + 2] = (px[i + 2] * a) / 255;
      }
    }
    const tex = this.compositor.uploadPixels(null, px, w, h);
    this.images.set(mediaId, tex);
    return tex;
  }

  private async video(info: MediaInfo, layer: MediaLayer, previewLongSide: number, readerBudget: number): Promise<TextureInfo | null> {
    // Decode no larger than the layer is drawn or the current preview quality requires.
    const shownW = layer.width / Math.max(0.01, 1 - layer.crop.left - layer.crop.right);
    const shownH = layer.height / Math.max(0.01, 1 - layer.crop.top - layer.crop.bottom);
    const memoryScale = this.options.downsizeReaders ? Math.sqrt(readerBudget / (16 * info.width * info.height)) : Infinity;
    const cap = Math.min(previewLongSide / Math.max(info.width, info.height), memoryScale);
    const need = Math.min(1, cap, Math.max(shownW / info.width, shownH / info.height));
    const decoder = this.androidDecoder(info);
    let reader = this.readers.get(layer.elementId);
    const desiredWidth = info.width * need;
    const tooLarge = this.options.downsizeReaders && reader
      && (reader.width > desiredWidth * 1.5 || reader.width > info.width * cap * 1.25);
    if (!reader || reader.sourcePath !== info.path || reader.decoder !== decoder || tooLarge || desiredWidth > reader.width * 1.5) {
      reader?.dispose();
      const s = Math.min(1, cap, need * (reader && !tooLarge ? 1.25 : 1));
      reader = new VideoReader(this.compositor, this.ctx, info, even(info.width * s), even(info.height * s), decoder);
      this.readers.set(layer.elementId, reader);
    }
    reader.configureMemory(readerBudget);
    reader.lastUsed = this.tick;
    const texture = reader.textureAt(layer.sourceSeconds, layer.reversed && layer.sourceSeconds > layer.sourceInSourceSeconds);
    if (!decoder) return texture;
    const decoded = await texture.catch(() => null);
    if (decoded) return decoded;
    this.unavailableAndroidDecoders.add(info.path);
    reader.dispose();
    this.readers.delete(layer.elementId);
    return this.video(info, layer, previewLongSide, readerBudget);
  }

  private androidDecoder(info: MediaInfo): AndroidDecoder | undefined {
    if (!this.androidMediaCodec || this.unavailableAndroidDecoders.has(info.path)) return;
    if (info.colorTransfer === "smpte2084" || info.colorTransfer === "arib-std-b67") return;
    if (info.videoCodec === "h264") return "h264_mediacodec";
    if (info.videoCodec === "hevc") return "hevc_mediacodec";
  }

  /** Decode every frame a scene needs. */
  async prepare(layers: MediaLayer[], previewLongSide = Infinity): Promise<string[]> {
    this.tick++;
    this.frameTextures.clear();
    this.maskTextures.clear();
    const warnings: string[] = [];
    const activeReaders = new Set<string>();
    for (const layer of layers) {
      const media = this.ctx.media[layer.mediaId];
      if (media && media.kind !== "image" && layer.mediaKind !== "image") activeReaders.add(layer.elementId);
      for (const ref of layer.subjectMasks) activeReaders.add(`${layer.elementId}:mask:${ref.maskMediaId}`);
    }
    const memoryBytes = this.options.readerMemoryBytes ?? DEFAULT_READER_MEMORY;
    const readerBudget = memoryBytes / Math.max(1, activeReaders.size);
    for (const [id, reader] of this.readers) {
      if (!activeReaders.has(id)) reader.idle();
    }
    // Subject masks: small grayscale videos read frame-exactly, like any other video.
    for (const layer of layers) {
      for (const ref of layer.subjectMasks) {
        const info = this.ctx.media[ref.maskMediaId];
        if (!info || !fs.existsSync(info.path)) {
          warnings.push(`Subject mask missing for ${layer.elementId}`);
          continue;
        }
        const key = `${layer.elementId}:mask:${ref.maskMediaId}`;
        let reader = this.readers.get(key);
        if (!reader) {
          reader = new VideoReader(this.compositor, this.ctx, info, even(info.width), even(info.height));
          this.readers.set(key, reader);
        }
        reader.configureMemory(readerBudget);
        reader.lastUsed = this.tick;
        const tex = await reader.textureAt(ref.maskSeconds, layer.reversed && ref.maskSeconds > 0);
        if (tex) this.maskTextures.set(`${layer.elementId}:${ref.instanceId}`, tex);
      }
    }
    for (const layer of layers) {
      const info = this.ctx.media[layer.mediaId];
      if (!info || !fs.existsSync(info.path)) {
        warnings.push(`Media file missing for ${layer.elementId}: ${info?.path ?? layer.mediaId}`);
        continue;
      }
      try {
        let tex: TextureInfo | null;
        if (layer.mediaKind === "image" || info.kind === "image") tex = await this.image(layer.mediaId, info);
        else {
          const proxy = info.editingProxy;
          tex = null;
          if (proxy && !this.unavailableProxies.has(proxy.path) && fs.existsSync(proxy.path)) {
            tex = await this.video({ ...info, ...proxy, videoCodec: "h264" }, layer, previewLongSide, readerBudget).catch(() => null);
            if (!tex) this.unavailableProxies.add(proxy.path);
          }
          tex ??= await this.video(info, layer, previewLongSide, readerBudget);
        }
        if (tex) this.frameTextures.set(layer.elementId, tex);
        else warnings.push(`Could not decode a frame for ${layer.elementId}`);
      } catch (e) {
        warnings.push(`Decode failed for ${layer.elementId}: ${(e as Error).message}`);
      }
    }
    // Leave spare GPU memory for the compositor instead of holding textures across cuts.
    let textureBytes = 0;
    const inactive = [...this.readers].filter(([id]) => !activeReaders.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const r of this.readers.values()) if (r.texture) textureBytes += r.frameBytes;
    for (const [id, r] of inactive) {
      if (this.tick - r.lastUsed <= 90 && this.readers.size <= 12 && textureBytes <= memoryBytes / 2) continue;
      if (r.texture) textureBytes -= r.frameBytes;
      r.dispose();
      this.readers.delete(id);
    }
    return warnings;
  }

  media(layer: MediaLayer): TextureInfo | null {
    return this.frameTextures.get(layer.elementId) ?? null;
  }

  mask(layer: MediaLayer, instanceId: string): TextureInfo | null {
    return this.maskTextures.get(`${layer.elementId}:${instanceId}`) ?? null;
  }

  lut(ref: { id: string; cubePath?: string }): LutTexture | null {
    const key = ref.cubePath ?? ref.id;
    if (this.luts.has(key)) return this.luts.get(key)!;
    let result: LutTexture | null = null;
    const file = this.ctx.luts[key];
    if (file && fs.existsSync(file)) {
      const cube = parseCube(fs.readFileSync(file, "utf8"));
      result = this.compositor.createLut(cube.data, cube.size);
    } else if (!ref.cubePath) {
      // Camera LUTs are generated from the log curves, not read from files.
      const generated = builtinLut(ref.id);
      if (generated) result = this.compositor.createLut(generated.data, generated.size);
    }
    this.luts.set(key, result);
    return result;
  }
}

