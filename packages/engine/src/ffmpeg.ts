import { spawn } from "node:child_process";
import fs from "node:fs";
import { EditError } from "@openedits/core";

export const ffmpegPath = () => process.env.OPENEDITS_FFMPEG ?? "ffmpeg";

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with each stderr line (progress, analysis output). */
  onLine?: (line: string) => void;
  /** Collect stdout as binary. */
  collectStdout?: boolean;
}

/** Run ffmpeg and resolve with its stderr (and stdout when collected). Rejects with the last stderr lines on failure. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<{ stderr: string; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", opts.collectStdout ? "pipe" : "ignore", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    let pending = "";
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderr = (stderr + text).slice(-64_000);
      if (opts.onLine) {
        pending += text;
        const lines = pending.split(/[\r\n]+/);
        pending = lines.pop() ?? "";
        for (const l of lines) if (l) opts.onLine(l);
      }
    });
    const abort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => reject(new EditError("INTERNAL", `Could not run ffmpeg: ${e.message}`)));
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) return reject(new EditError("INTERNAL", "Cancelled"));
      if (code !== 0) return reject(new EditError("INTERNAL", `ffmpeg failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
      resolve({ stderr, stdout: Buffer.concat(out) });
    });
  });
}

export interface DecodeOptions {
  startSeconds?: number;
  durationSeconds?: number;
  sampleRate: number;
  channels: 1 | 2;
  /** Audio filter chain (-af). */
  filters?: string;
  /** Full filter graph ending in [out] (overrides filters). */
  filterComplex?: string;
  signal?: AbortSignal;
}

/** Decode (part of) a file's audio to interleaved float32 PCM. */
export async function decodePcm(file: string, opts: DecodeOptions): Promise<Float32Array> {
  if (!fs.existsSync(file)) throw new EditError("FILE_NOT_FOUND", `File not found: ${file}`, { path: file });
  const args = ["-v", "error"];
  if (opts.startSeconds !== undefined && opts.startSeconds > 0) args.push("-ss", opts.startSeconds.toFixed(6));
  if (opts.durationSeconds !== undefined) args.push("-t", Math.max(0, opts.durationSeconds).toFixed(6));
  args.push("-i", file, "-vn");
  if (opts.filterComplex) args.push("-filter_complex", opts.filterComplex, "-map", "[out]");
  else if (opts.filters) args.push("-af", opts.filters);
  args.push("-ac", String(opts.channels), "-ar", String(opts.sampleRate), "-f", "f32le", "-");
  const { stdout } = await runFfmpeg(args, { collectStdout: true, signal: opts.signal });
  const n = Math.floor(stdout.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = stdout.readFloatLE(i * 4);
  return out;
}

/** Write interleaved float32 samples as a 32-bit float WAV. */
export function writeWav(file: string, samples: Float32Array, sampleRate: number, channels: number) {
  const dataBytes = samples.length * 4;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, header);
    fs.writeSync(fd, Buffer.from(samples.buffer, samples.byteOffset, dataBytes));
  } finally {
    fs.closeSync(fd);
  }
}

/** atempo accepts 0.5..100; chain stages for slower rates. */
export function atempoChain(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r < 0.5) {
    out.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-6) out.push(`atempo=${Math.min(100, r).toFixed(6)}`);
  return out;
}
