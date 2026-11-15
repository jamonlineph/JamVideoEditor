import fs from "node:fs";
import { buildAudioPlan, clipGainAt, compositionDuration, type AudioClipPlan, type Project } from "@openedits/core";
import { atempoChain, decodePcm } from "../ffmpeg.js";

export const MIX_SAMPLE_RATE = 48000;

export interface MixResult {
  /** Interleaved stereo float32. */
  samples: Float32Array;
  sampleRate: number;
  channels: 2;
  startSeconds: number;
  durationSeconds: number;
  clipCount: number;
  warnings: string[];
}

export interface MixOptions {
  startSeconds?: number;
  endSeconds?: number;
  signal?: AbortSignal;
  concurrency?: number;
}

/** ffmpeg filter description that turns a clip's source window into playback-order, speed-adjusted stereo. */
export function clipFilterGraph(clip: AudioClipPlan): { filters?: string; filterComplex?: string } {
  // Mono sources play at unity in both channels (ffmpeg's default upmix would drop them by 3 dB).
  const pre = [`aresample=${MIX_SAMPLE_RATE}`, clip.sourceChannels === 1 ? "pan=stereo|c0=c0|c1=c0" : "aformat=sample_fmts=flt:channel_layouts=stereo"];
  if (clip.reversed) pre.push("areverse");
  const ve = clip.voiceEnhance;
  if (ve.enabled && (ve.reduceNoise > 0 || ve.enhanceVoice > 0)) {
    pre.push("highpass=f=80");
    if (ve.reduceNoise > 0) pre.push(`afftdn=nr=${Math.max(0.5, ve.reduceNoise * 0.4).toFixed(1)}:nf=-30`);
    if (ve.enhanceVoice > 0) {
      pre.push(`equalizer=f=3200:t=q:w=1.2:g=${(ve.enhanceVoice * 0.06).toFixed(2)}`);
      pre.push(`equalizer=f=220:t=q:w=1:g=${(-ve.enhanceVoice * 0.03).toFixed(2)}`);
      pre.push(`acompressor=threshold=-18dB:ratio=${(1 + ve.enhanceVoice / 50).toFixed(2)}:attack=10:release=120:makeup=${(1 + ve.enhanceVoice / 100).toFixed(2)}`);
    }
  }
  if (clip.segments.length === 1) return { filters: [...pre, ...atempoChain(clip.segments[0].rate)].join(",") };
  const span = clip.sourceDurationSourceSeconds;
  const k = clip.segments.length;
  const parts = [`[0:a]${pre.join(",")},asplit=${k}${clip.segments.map((_, i) => `[s${i}]`).join("")}`];
  clip.segments.forEach((seg, i) => {
    const chain = [`atrim=start=${(seg.p0 * span).toFixed(6)}:end=${(seg.p1 * span).toFixed(6)}`, "asetpts=PTS-STARTPTS", ...atempoChain(seg.rate)];
    parts.push(`[s${i}]${chain.join(",")}[t${i}]`);
  });
  parts.push(`${clip.segments.map((_, i) => `[t${i}]`).join("")}concat=n=${k}:v=0:a=1[out]`);
  return { filterComplex: parts.join(";") };
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

const BLOCK = 128;

/** Add a decoded clip into `dest` at its timeline position with its gain envelope (and optional extra per-frame gain). */
function place(dest: Float32Array, pcm: Float32Array, clip: AudioClipPlan, rangeStart: number, extraGain?: (frame: number) => number) {
  const sr = MIX_SAMPLE_RATE;
  const frames = Math.min(Math.floor(pcm.length / 2), Math.round(clip.durationSeconds * sr));
  const offset = Math.round((clip.startSeconds - rangeStart) * sr);
  const total = dest.length / 2;
  for (let b = 0; b < frames; b += BLOCK) {
    const g0 = clipGainAt(clip, b / sr);
    const g1 = clipGainAt(clip, Math.min(frames, b + BLOCK) / sr);
    const end = Math.min(frames, b + BLOCK);
    for (let i = b; i < end; i++) {
      const o = offset + i;
      if (o < 0) continue;
      if (o >= total) return;
      let g = g0 + ((g1 - g0) * (i - b)) / BLOCK;
      if (extraGain) g *= extraGain(o);
      dest[o * 2] += pcm[i * 2] * g;
      dest[o * 2 + 1] += pcm[i * 2 + 1] * g;
    }
  }
}

/** Per-frame gain that lowers a clip while the voice bus is active. */
function duckGain(voice: Float32Array, clip: AudioClipPlan): (frame: number) => number {
  const sr = MIX_SAMPLE_RATE;
  const hop = 480; // 10 ms
  const blocks = Math.ceil(voice.length / 2 / hop);
  const gains = new Float32Array(blocks + 1);
  const low = Math.pow(10, clip.ducking.amountDb / 20);
  const attack = 1 - Math.exp(-(hop / sr) / Math.max(0.005, clip.ducking.attackSeconds));
  const release = 1 - Math.exp(-(hop / sr) / Math.max(0.005, clip.ducking.releaseSeconds));
  let g = 1;
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    const end = Math.min(voice.length, (b + 1) * hop * 2);
    for (let i = b * hop * 2; i < end; i++) sum += voice[i] * voice[i];
    const speaking = sum / (hop * 2) > 1e-4; // about -40 dBFS RMS
    const target = speaking ? low : 1;
    g += (target - g) * (target < g ? attack : release);
    gains[b] = g;
  }
  gains[blocks] = g;
  return (frame) => {
    const pos = frame / hop;
    const i = Math.min(blocks - 1, Math.floor(pos));
    return gains[i] + (gains[i + 1] - gains[i]) * (pos - i);
  };
}

/** Render the timeline's audio to stereo PCM: per-clip decode and time-stretch in ffmpeg, mixing, ducking and limiting here. */
export async function renderAudioMix(project: Project, opts: MixOptions = {}): Promise<MixResult> {
  const sr = MIX_SAMPLE_RATE;
  const start = Math.max(0, opts.startSeconds ?? 0);
  const end = Math.max(start, Math.min(opts.endSeconds ?? Infinity, compositionDuration(project)));
  const duration = end - start;
  const warnings: string[] = [];
  const clips = buildAudioPlan(project).filter((c) => c.startSeconds < end && c.startSeconds + c.durationSeconds > start);
  const voice = new Float32Array(Math.round(duration * sr) * 2);
  const other = new Float32Array(voice.length);

  const decode = async (clip: AudioClipPlan): Promise<Float32Array | null> => {
    if (!fs.existsSync(clip.path)) {
      warnings.push(`Missing media for ${clip.elementId}: ${clip.path}`);
      return null;
    }
    try {
      return await decodePcm(clip.path, {
        startSeconds: clip.sourceInSourceSeconds,
        durationSeconds: clip.sourceDurationSourceSeconds,
        sampleRate: sr,
        channels: 2,
        signal: opts.signal,
        ...clipFilterGraph(clip),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      warnings.push(`Could not decode audio for ${clip.elementId}: ${(e as Error).message}`);
      return null;
    }
  };

  const limit = opts.concurrency ?? 6;
  await pool(clips.filter((c) => c.isVoice), limit, async (clip) => {
    const pcm = await decode(clip);
    if (pcm) place(voice, pcm, clip, start);
  });
  await pool(clips.filter((c) => !c.isVoice), limit, async (clip) => {
    const pcm = await decode(clip);
    if (pcm) place(other, pcm, clip, start, clip.ducking.enabled ? duckGain(voice, clip) : undefined);
  });

  // Sum buses and soft-limit peaks above -0.5 dBFS.
  const t = 0.944;
  for (let i = 0; i < other.length; i++) {
    const x = other[i] + voice[i];
    const a = Math.abs(x);
    other[i] = a <= t ? x : Math.sign(x) * (t + (1 - t) * Math.tanh((a - t) / (1 - t)));
  }
  return { samples: other, sampleRate: sr, channels: 2, startSeconds: start, durationSeconds: duration, clipCount: clips.length, warnings };
}

/** Average the channels of interleaved stereo. */
export function toMono(stereo: Float32Array): Float32Array {
  const out = new Float32Array(stereo.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (stereo[i * 2] + stereo[i * 2 + 1]) / 2;
  return out;
}
