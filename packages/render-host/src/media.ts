import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { MediaLayer, MediaRenderInfo as MediaInfo, RenderContext } from "@openedits/core";
import { parseCube, type Compositor, type LutTexture, type SceneResources, type TextureInfo } from "@openedits/renderer";

export const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

/** Sequential raw-frame reader over an ffmpeg pipe, with a chunk cache for backwards playback. */
export class VideoReader {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = true;
  private wake: (() => void) | null = null;
  private nextIndex = 0;
  private last: { index: number; data: Uint8Array } | null = null;
  private cache = new Map<number, Uint8Array>();
  private uploadedIndex = -1;
  texture: TextureInfo | null = null;
  lastUsed = 0;
  readonly frameBytes: number;

  constructor(private compositor: Compositor, private ctx: RenderContext, private info: MediaInfo, readonly width: number, readonly height: number) {
    this.frameBytes = width * height * 4;
  }

  private start(index: number) {
    this.stop();
    const args = ["-v", "error", "-nostdin"];
    if (this.ctx.hwaccel !== false) args.push("-hwaccel", "videotoolbox");
    // Seek half a frame early so the first decoded frame is exactly `index`.
    if (index > 0) args.push("-ss", ((index - 0.5) / this.info.fps).toFixed(6));
    const scale = `scale=${this.width}:${this.height}:flags=bilinear${this.info.inColorMatrix ? `:in_color_matrix=${this.info.inColorMatrix}` : ""}`;
    // One output frame per decoded frame: frame k after the seek is source frame index + k (exact for constant-rate media).
    args.push("-i", this.info.path, "-an", "-sn", "-dn", "-vf", scale, "-fps_mode", "passthrough", "-pix_fmt", "rgba", "-f", "rawvideo", "-");
    const proc = spawn(this.ctx.ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"] });
    this.proc = proc;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.nextIndex = index;
    proc.stdout!.on("data", (d: Buffer) => {
      if (this.proc !== proc) return;
      this.chunks.push(d);
      this.buffered += d.length;
      if (this.buffered > this.frameBytes * 3) proc.stdout!.pause();
      this.wake?.();
    });
    const finish = () => {
      if (this.proc !== proc) return;
      this.ended = true;
      this.wake?.();
    };
    proc.on("close", finish);
    proc.on("error", finish);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ended = true;
    this.chunks = [];
    this.buffered = 0;
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
    if (this.buffered < this.frameBytes * 2) this.proc?.stdout?.resume();
    this.nextIndex++;
    return frame;
  }

  /** The frame with the given source index (holding the last frame past the end of the file). */
  async frame(index: number): Promise<Uint8Array | null> {
    index = Math.max(0, index);
    if (this.last?.index === index) return this.last.data;
    const cached = this.cache.get(index);
    if (cached) {
      this.last = { index, data: cached };
      return cached;
    }
    if (this.last && index < this.last.index) {
      // Playing backwards: decode a chunk that ends at `index` and serve from memory.
      const size = Math.max(4, Math.min(60, Math.floor((192 * 1024 * 1024) / this.frameBytes)));
      const first = Math.max(0, index - size + 1);
      this.cache.clear();
      this.start(first);
      for (let i = first; i <= index; i++) {
        const data = await this.read();
        if (!data) break;
        this.cache.set(i, data);
      }
      this.stop();
      const data = this.cache.get(index) ?? [...this.cache.values()].pop() ?? this.last.data;
      this.last = { index, data };
      return data;
    }
    this.cache.clear();
    if (!this.proc || this.ended && this.buffered < this.frameBytes || index < this.nextIndex || index - this.nextIndex > this.info.fps * 2) this.start(index);
    let data: Uint8Array | null = null;
    while (this.nextIndex <= index) {
      const f = await this.read();
      if (!f) break;
      data = f;
    }
    if (!data) return this.last?.data ?? null;
    this.last = { index, data };
    return data;
  }

  async textureAt(index: number): Promise<TextureInfo | null> {
    const data = await this.frame(index);
    if (!data) return this.texture;
    const actual = this.last?.index ?? index;
    if (!this.texture || this.uploadedIndex !== actual) {
      this.texture = this.compositor.uploadPixels(this.texture, data, this.width, this.height);
      this.uploadedIndex = actual;
    }
    return this.texture;
  }

  dispose() {
    this.stop();
    this.cache.clear();
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
  private luts = new Map<string, LutTexture | null>();
  private frameTextures = new Map<string, TextureInfo>();
  private maskTextures = new Map<string, TextureInfo>();
  private tick = 0;
  ctx!: RenderContext;
  private signature = "";

  constructor(private compositor: Compositor) {}

  /** Reset caches when the set of media files changes. */
  use(ctx: RenderContext) {
    const sig = JSON.stringify([Object.entries(ctx.media).map(([id, m]) => [id, m.path, m.width, m.height]), ctx.luts]);
    if (sig !== this.signature) this.reset();
    this.signature = sig;
    this.ctx = ctx;
  }

  reset() {
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
    for (const t of this.images.values()) this.compositor.deleteTexture(t);
    this.images.clear();
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

  /** Decode every frame a scene needs. */
  async prepare(layers: MediaLayer[]): Promise<string[]> {
    this.tick++;
    this.frameTextures.clear();
    this.maskTextures.clear();
    const warnings: string[] = [];
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
        reader.lastUsed = this.tick;
        const tex = await reader.textureAt(Math.floor(ref.maskSeconds * info.fps + 1e-3));
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
          // Decode no larger than the layer is drawn (never above source resolution).
          const shownW = layer.width / Math.max(0.01, 1 - layer.crop.left - layer.crop.right);
          const shownH = layer.height / Math.max(0.01, 1 - layer.crop.top - layer.crop.bottom);
          const need = Math.min(1, Math.max(shownW / info.width, shownH / info.height));
          let reader = this.readers.get(layer.elementId);
          if (!reader || info.width * need > reader.width * 1.5) {
            reader?.dispose();
            const s = Math.min(1, need * (reader ? 1.25 : 1));
            reader = new VideoReader(this.compositor, this.ctx, info, even(info.width * s), even(info.height * s));
            this.readers.set(layer.elementId, reader);
          }
          reader.lastUsed = this.tick;
          tex = await reader.textureAt(Math.floor(layer.sourceSeconds * info.fps + 1e-3));
        }
        if (tex) this.frameTextures.set(layer.elementId, tex);
        else warnings.push(`Could not decode a frame for ${layer.elementId}`);
      } catch (e) {
        warnings.push(`Decode failed for ${layer.elementId}: ${(e as Error).message}`);
      }
    }
    // Drop readers that have not been needed for a while.
    for (const [id, r] of this.readers) {
      if (this.tick - r.lastUsed > 90 || (this.readers.size > 12 && this.tick - r.lastUsed > 2)) {
        r.dispose();
        this.readers.delete(id);
      }
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
    }
    this.luts.set(key, result);
    return result;
  }
}

