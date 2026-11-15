import { spawn } from "node:child_process";
import fs from "node:fs";
import { ipcRenderer } from "electron";
import { evaluateScene, sceneMediaLayers, type RenderContext } from "@openedits/core";
import { Compositor } from "@openedits/renderer";
import { MediaManager } from "./media.js";

const canvas = document.createElement("canvas");
const compositor = new Compositor(canvas);

const media = new MediaManager(compositor);

async function renderScene(ctx: RenderContext, time: number, width: number, height: number): Promise<string[]> {
  const scene = evaluateScene(ctx.project, time, { width, height }, { hideCaptions: ctx.hideCaptions });
  const warnings = await media.prepare(sceneMediaLayers(scene));
  return [...warnings, ...compositor.render(scene, media)];
}

async function saveCanvas(target: HTMLCanvasElement, file: string, format: "jpeg" | "png", quality: number) {
  const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, `image/${format}`, quality));
  if (!blob) throw new Error("Could not encode the image");
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
}

/** Encode RGBA pixels (top row first) to PNG or JPEG with ffmpeg. */
function encodeImage(ffmpeg: string, pixels: Uint8Array, width: number, height: number, file: string, format: "jpeg" | "png", quality: number): Promise<void> {
  const q = String(Math.round(2 + (1 - quality) * 29)); // mjpeg qscale: 2 (best) .. 31
  const codec = format === "png" ? ["-pix_fmt", "rgb24", "-c:v", "png"] : ["-pix_fmt", "yuvj444p", "-c:v", "mjpeg", "-q:v", q];
  const proc = spawn(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "-", "-frames:v", "1", ...codec, file], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Image encode failed: ${err.trim()}`))));
    proc.stdin!.end(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  });
}

function drawLabel(g: CanvasRenderingContext2D, label: string, x: number, y: number, tileH: number) {
  if (!label) return;
  const size = Math.max(11, Math.round(tileH * 0.065));
  g.font = `600 ${size}px Menlo, monospace`;
  g.textBaseline = "top";
  const w = g.measureText(label).width + size * 0.7;
  g.fillStyle = "rgba(0,0,0,0.72)";
  g.fillRect(x, y, w, size * 1.5);
  g.fillStyle = "#fff";
  g.fillText(label, x + size * 0.35, y + size * 0.28);
}

function sheetCanvas(count: number, columns: number, tileW: number, tileH: number) {
  const gap = 4;
  const rows = Math.ceil(count / columns);
  const sheet = document.createElement("canvas");
  sheet.width = columns * tileW + (columns + 1) * gap;
  sheet.height = rows * tileH + (rows + 1) * gap;
  const g = sheet.getContext("2d", { colorSpace: "srgb" })!;
  g.fillStyle = "#16181c";
  g.fillRect(0, 0, sheet.width, sheet.height);
  const at = (i: number) => ({ x: gap + (i % columns) * (tileW + gap), y: gap + Math.floor(i / columns) * (tileH + gap) });
  return { sheet, g, at };
}

type Progress = (data: Record<string, unknown>) => void;
const cancelled = new Set<unknown>();

const handlers: Record<string, (params: any, progress: Progress, id: unknown) => Promise<unknown>> = {
  async ping() {
    const gl = compositor.gl;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return { ok: true, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown", maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  },

  /** Render composited frames to image files. Pixels are read back exactly and encoded by ffmpeg (no browser color management). */
  async renderFrames(p: { ctx: RenderContext; times: number[]; width: number; height: number; outputs: string[]; format: "jpeg" | "png"; quality?: number }) {
    media.use(p.ctx);
    const warnings = new Set<string>();
    const pixels = new Uint8Array(p.width * p.height * 4);
    for (let i = 0; i < p.times.length; i++) {
      for (const w of await renderScene(p.ctx, p.times[i], p.width, p.height)) warnings.add(w);
      compositor.readPixels(pixels);
      await encodeImage(p.ctx.ffmpeg, pixels, p.width, p.height, p.outputs[i], p.format, p.quality ?? 0.85);
    }
    return { width: p.width, height: p.height, warnings: [...warnings] };
  },

  /** Render composited frames into one labelled contact sheet. */
  async renderSheet(p: { ctx: RenderContext; times: number[]; labels: string[]; tileWidth: number; tileHeight: number; columns: number; output: string; quality?: number }) {
    media.use(p.ctx);
    const warnings = new Set<string>();
    const { sheet, g, at } = sheetCanvas(p.times.length, p.columns, p.tileWidth, p.tileHeight);
    const pixels = new Uint8ClampedArray(p.tileWidth * p.tileHeight * 4);
    for (let i = 0; i < p.times.length; i++) {
      for (const w of await renderScene(p.ctx, p.times[i], p.tileWidth, p.tileHeight)) warnings.add(w);
      compositor.readPixels(new Uint8Array(pixels.buffer));
      const { x, y } = at(i);
      g.putImageData(new ImageData(pixels, p.tileWidth, p.tileHeight), x, y);
      drawLabel(g, p.labels[i] ?? "", x, y, p.tileHeight);
    }
    await saveCanvas(sheet, p.output, "jpeg", p.quality ?? 0.82);
    return { width: sheet.width, height: sheet.height, warnings: [...warnings] };
  },

  /** Lay out existing image files (e.g. source frames) as a labelled contact sheet. */
  async composeSheet(p: { tiles: { path: string; label: string }[]; columns: number; tileWidth: number; tileHeight: number; output: string; quality?: number }) {
    const { sheet, g, at } = sheetCanvas(p.tiles.length, p.columns, p.tileWidth, p.tileHeight);
    for (let i = 0; i < p.tiles.length; i++) {
      const { x, y } = at(i);
      if (fs.existsSync(p.tiles[i].path)) {
        const bmp = await createImageBitmap(new Blob([fs.readFileSync(p.tiles[i].path)]));
        const s = Math.min(p.tileWidth / bmp.width, p.tileHeight / bmp.height);
        g.drawImage(bmp, x + (p.tileWidth - bmp.width * s) / 2, y + (p.tileHeight - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
        bmp.close();
      }
      drawLabel(g, p.tiles[i].label, x, y, p.tileHeight);
    }
    await saveCanvas(sheet, p.output, "jpeg", p.quality ?? 0.82);
    return { width: sheet.width, height: sheet.height };
  },

  /** Render a frame range and pipe raw frames into an ffmpeg encoder. */
  async renderVideo(p: { ctx: RenderContext; times: number[]; width: number; height: number; ffmpegArgs: string[] }, progress, id) {
    media.use(p.ctx);
    const warnings = new Set<string>();
    const encoder = spawn(p.ctx.ffmpeg, p.ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let failed: Error | null = null;
    encoder.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    encoder.stdin!.on("error", (e) => (failed = e));
    const closed = new Promise<number | null>((resolve) => {
      encoder.on("close", resolve);
      encoder.on("error", (e) => {
        failed = e;
        resolve(-1);
      });
    });
    const pixels = new Uint8Array(p.width * p.height * 4);
    const started = performance.now();
    try {
      for (let i = 0; i < p.times.length; i++) {
        if (cancelled.has(id)) throw new Error("Cancelled");
        if (failed || encoder.exitCode !== null) throw new Error(`Encoder stopped: ${stderr.trim().split("\n").pop() ?? failed}`);
        for (const w of await renderScene(p.ctx, p.times[i], p.width, p.height)) warnings.add(w);
        compositor.readPixels(pixels);
        await new Promise<void>((resolve, reject) => encoder.stdin!.write(pixels, (e) => (e ? reject(e) : resolve())));
        if (i % 15 === 0 || i === p.times.length - 1) progress({ frame: i + 1, total: p.times.length, fps: ((i + 1) / (performance.now() - started)) * 1000 });
      }
      encoder.stdin!.end();
      const code = await closed;
      if (code !== 0) throw new Error(`Encoder failed (${code}): ${stderr.trim().split("\n").slice(-2).join(" | ")}`);
    } catch (e) {
      encoder.kill("SIGKILL");
      throw e;
    } finally {
      cancelled.delete(id);
    }
    return { frames: p.times.length, seconds: (performance.now() - started) / 1000, warnings: [...warnings] };
  },

  async releaseMedia() {
    media.reset();
    return { ok: true };
  },
};

// One request at a time: the compositor and frame readers are shared state.
let queue: Promise<void> = Promise.resolve();
ipcRenderer.on("from-engine", (_event, msg: { id: unknown; method: string; params: unknown }) => {
  if (msg.method === "cancel") {
    cancelled.add((msg.params as { id: unknown }).id);
    return;
  }
  queue = queue.then(async () => {
    const handler = handlers[msg.method];
    try {
      if (!handler) throw new Error(`Unknown method ${msg.method}`);
      const result = await handler(msg.params, (data) => ipcRenderer.send("to-engine", { id: msg.id, progress: data }), msg.id);
      ipcRenderer.send("to-engine", { id: msg.id, ok: true, result });
    } catch (e) {
      ipcRenderer.send("to-engine", { id: msg.id, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  });
});
