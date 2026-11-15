import { EditError } from "@openedits/core";
import { runFfmpeg } from "../ffmpeg.js";

const SIG_W = 32;
const SIG_H = 18;

export interface FrameSignatures {
  fps: number;
  /** Time of frame 0 (seconds). */
  startSeconds: number;
  /** One 32x18 grayscale signature (0..1) per decoded frame. */
  frames: Float32Array[];
}

/** Decode every frame once into a tiny grayscale signature. */
export async function frameSignatures(file: string, fps: number, opts: { startSeconds?: number; durationSeconds?: number; signal?: AbortSignal } = {}): Promise<FrameSignatures> {
  const start = Math.max(0, opts.startSeconds ?? 0);
  const args = ["-v", "error"];
  if (start > 0) args.push("-ss", Math.max(0, start - 0.5 / fps).toFixed(4));
  if (opts.durationSeconds !== undefined) args.push("-t", opts.durationSeconds.toFixed(4));
  args.push("-i", file, "-an", "-sn", "-vf", `scale=${SIG_W}:${SIG_H}:flags=area,format=gray`, "-fps_mode", "passthrough", "-f", "rawvideo", "-");
  const { stdout } = await runFfmpeg(args, { collectStdout: true, signal: opts.signal });
  const size = SIG_W * SIG_H;
  const frames: Float32Array[] = [];
  for (let off = 0; off + size <= stdout.length; off += size) frames.push(Float32Array.from(stdout.subarray(off, off + size), (b) => b / 255));
  if (!frames.length) throw new EditError("UNSUPPORTED_MEDIA", "No video frames could be decoded");
  return { fps, startSeconds: start, frames };
}

function diff(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export interface Cut {
  /** First frame of the new shot (seconds). */
  time: number;
  score: number;
}

export interface Dissolve {
  /** Last frame that is purely the outgoing shot, and first frame that is purely the incoming one. */
  start: number;
  end: number;
  score: number;
}

export interface ShotAnalysis {
  cuts: Cut[];
  dissolves: Dissolve[];
}

/**
 * Twin-comparison shot boundary detection. Hard cuts are frame differences far above the local
 * level. Dissolves are runs of small differences whose effect accumulates: the frames at either end
 * of the run differ about as much as all the steps added up (motion inside a shot does not).
 */
export function detectBoundaries(sig: FrameSignatures, opts: { cutThreshold?: number } = {}): ShotAnalysis {
  const f = sig.frames;
  const n = f.length;
  const time = (i: number) => Math.round((sig.startSeconds + i / sig.fps) * 1000) / 1000;
  const d1 = new Float32Array(n);
  for (let i = 1; i < n; i++) d1[i] = diff(f[i], f[i - 1]);
  const cutT = opts.cutThreshold ?? 0.08;
  const cuts: Cut[] = [];
  const isCut = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const v = d1[i];
    if (v < cutT || v < d1[i - 1] || (i + 1 < n && v < d1[i + 1])) continue;
    let local = 0;
    let c = 0;
    for (let j = Math.max(1, i - 10); j < Math.min(n, i + 11); j++) if (j !== i) {
      local += d1[j];
      c++;
    }
    if (v < 4 * (local / Math.max(1, c)) + 0.01) continue;
    cuts.push({ time: time(i), score: Math.round(v * 1000) / 1000 });
    isCut[i] = 1;
  }
  // "Changing" is relative to the surrounding second, so motion inside the next shot does not merge into a dissolve.
  const half = Math.max(15, Math.round(sig.fps));
  const low = new Float32Array(n);
  const win: number[] = [];
  for (let i = 1; i < n; i++) {
    win.length = 0;
    for (let j = Math.max(1, i - half); j < Math.min(n, i + half + 1); j++) if (!isCut[j]) win.push(d1[j]);
    win.sort((a, b) => a - b);
    low[i] = Math.max(0.0015, 2 * (win[win.length >> 2] ?? 0)); // 25th percentile: a dissolve cannot raise its own baseline
  }
  const dissolves: Dissolve[] = [];
  let from = -1;
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const v = i < n ? d1[i] : 0;
    if (i < n && v >= low[i] && !isCut[i]) {
      if (from < 0) {
        from = i;
        sum = 0;
      }
      sum += v;
    } else if (from >= 0) {
      const frames = i - from;
      const total = diff(f[from - 1], f[i - 1]);
      if (frames >= 6 && total >= 0.06 && total >= 0.7 * sum) dissolves.push({ start: time(from - 1), end: time(i - 1), score: Math.round(total * 1000) / 1000 });
      from = -1;
    }
  }
  return { cuts, dissolves };
}

/** Group shots that look alike (same camera angle) by signature distance. */
export function groupAngles(signatures: Float32Array[], threshold = 0.08): number[] {
  const centers: Float32Array[] = [];
  return signatures.map((v) => {
    let best = -1;
    let bestD = Infinity;
    centers.forEach((c, k) => {
      const d = diff(v, c);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best >= 0 && bestD <= threshold) return best;
    centers.push(v);
    return centers.length - 1;
  });
}

export interface Shot {
  index: number;
  start: number;
  end: number;
  /** Shots with the same angle id look alike (same camera setup). */
  angle: number;
  /** How the shot begins. */
  startsWith: "start" | "cut" | "dissolve";
}

/** Shots between boundaries (a dissolve's midpoint separates its two shots), with angle groups. */
export function shotsFrom(sig: FrameSignatures, a: ShotAnalysis): Shot[] {
  const end = sig.startSeconds + sig.frames.length / sig.fps;
  const bounds = [
    ...a.cuts.map((c) => ({ t: c.time, kind: "cut" as const })),
    ...a.dissolves.map((d) => ({ t: (d.start + d.end) / 2, kind: "dissolve" as const })),
  ].sort((x, y) => x.t - y.t);
  const shots: Omit<Shot, "angle">[] = [];
  let t0 = sig.startSeconds;
  let kind: Shot["startsWith"] = "start";
  for (const b of bounds) {
    if (b.t - t0 > 1 / sig.fps) shots.push({ index: shots.length, start: t0, end: b.t, startsWith: kind });
    t0 = b.t;
    kind = b.kind;
  }
  shots.push({ index: shots.length, start: t0, end, startsWith: kind });
  const mids = shots.map((s) => sig.frames[Math.min(sig.frames.length - 1, Math.max(0, Math.round(((s.start + s.end) / 2 - sig.startSeconds) * sig.fps)))]);
  const angles = groupAngles(mids);
  return shots.map((s, i) => ({ ...s, start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000, angle: angles[i] }));
}
