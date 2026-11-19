import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { EditError } from "@openedits/core";

export const ffmpegPath = () => process.env.OPENEDITS_FFMPEG ?? "ffmpeg";

/** Expand a leading "~" to the home directory (works on Windows too, where $HOME is usually unset). */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

let encoderCache: { ffmpeg: string; names: Set<string> } | undefined;

/** Names of the encoders this ffmpeg build has (empty when ffmpeg cannot be run). */
export function ffmpegEncoders(): Set<string> {
  const ffmpeg = ffmpegPath();
  if (encoderCache?.ffmpeg === ffmpeg) return encoderCache.names;
  const names = new Set<string>();
  try {
    const out = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    for (const line of out.split("\n")) {
      const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
      if (m) names.add(m[1]);
    }
  } catch {
    /* reported when the encoder is actually needed */
  }
  encoderCache = { ffmpeg, names };
  return names;
}

export type VideoCodec = "h264" | "hevc" | "prores";

/** Encoders to try for each codec, best first. Apple's hardware encoders lead on macOS; elsewhere software ones do, because a listed hardware encoder may have no device behind it. */
const ENCODER_ORDER: Record<VideoCodec, { mac: string[]; other: string[] }> = {
  h264: { mac: ["h264_videotoolbox", "libx264", "libopenh264"], other: ["libx264", "libopenh264", "h264_mf", "h264_nvenc", "h264_qsv", "h264_amf"] },
  hevc: { mac: ["hevc_videotoolbox", "libx265"], other: ["libx265", "hevc_mf", "hevc_nvenc", "hevc_qsv", "hevc_amf"] },
  prores: { mac: ["prores_ks", "prores"], other: ["prores_ks", "prores"] },
};

/** Pick the video encoder for a codec on this machine, with its ffmpeg arguments (pixel format and color matrix included). */
export function videoEncoderArgs(codec: VideoCodec, bitrate: number, opts: { fast?: boolean } = {}): { encoder: string; args: string[] } {
  const available = ffmpegEncoders();
  const order = ENCODER_ORDER[codec][process.platform === "darwin" ? "mac" : "other"];
  // If ffmpeg could not be asked, try the first choice and let the encode report the problem.
  const encoder = available.size ? order.find((e) => available.has(e)) : order[0];
  if (!encoder) {
    const label = codec === "h264" ? "H.264" : codec === "hevc" ? "HEVC" : "ProRes";
    throw new EditError("INTERNAL", `This ffmpeg has no ${label} encoder (looked for ${order.join(", ")}). Install a full ffmpeg build${codec === "h264" ? "" : ", or export as H.264"}.`);
  }
  const b = String(Math.round(bitrate));
  if (codec === "prores") return { encoder, args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le", "-c:v", encoder, "-profile:v", "3", ...(encoder === "prores_ks" ? ["-vendor", "apl0"] : [])] };
  const format = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"];
  const preset = opts.fast ? "veryfast" : "medium";
  let enc: string[];
  if (encoder === "h264_videotoolbox") enc = ["-b:v", b, "-profile:v", "high", "-allow_sw", "1"];
  else if (encoder === "hevc_videotoolbox") enc = ["-b:v", b, "-tag:v", "hvc1", "-allow_sw", "1"];
  else if (encoder === "libx264") enc = ["-preset", preset, "-b:v", b, "-maxrate", String(Math.round(bitrate * 1.5)), "-bufsize", String(Math.round(bitrate * 2)), "-profile:v", "high"];
  else if (encoder === "libx265") enc = ["-preset", preset, "-b:v", b, "-tag:v", "hvc1", "-x265-params", "log-level=error"];
  else enc = ["-b:v", b, ...(codec === "hevc" ? ["-tag:v", "hvc1"] : [])];
  return { encoder, args: [...format, "-c:v", encoder, ...enc] };
}

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
  /** Exact sample range in the processed stream, at sampleRate. */
  outputSamples?: { start: number; count: number };
  signal?: AbortSignal;
}

/** Decode (part of) a file's audio to interleaved float32 PCM. */
export async function decodePcm(file: string, opts: DecodeOptions): Promise<Float32Array> {
  if (!fs.existsSync(file)) throw new EditError("FILE_NOT_FOUND", `File not found: ${file}`, { path: file });
  const args = ["-v", "error"];
  if (opts.startSeconds !== undefined && opts.startSeconds > 0) args.push("-ss", opts.startSeconds.toFixed(6));
  if (opts.durationSeconds !== undefined) args.push("-t", Math.max(0, opts.durationSeconds).toFixed(6));
  args.push("-i", file, "-vn");
  const window = opts.outputSamples;
  const trim = window && `aresample=${opts.sampleRate},atrim=start_sample=${window.start}:end_sample=${window.start + window.count},asetpts=PTS-STARTPTS`;
  if (opts.filterComplex) {
    const graph = trim ? `${opts.filterComplex.replace(/\[out\]$/, "[processed]")};[processed]${trim}[out]` : opts.filterComplex;
    args.push("-filter_complex", graph, "-map", "[out]");
  } else {
    const filters = [opts.filters, trim].filter(Boolean).join(",");
    if (filters) args.push("-af", filters);
  }
  if (window) args.push("-t", (window.count / opts.sampleRate).toFixed(9));
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
