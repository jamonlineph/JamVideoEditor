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
  /** Bound clip PCM allocations to the requested playback range. */
  playbackWindow?: boolean;
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
function place(dest: Float32Array, pcm: Float32Array, clip: AudioClipPlan, rangeStart: number, extraGain?: (frame: number) => number, firstFrame = 0) {
  const sr = MIX_SAMPLE_RATE;
  const frames = Math.min(firstFrame + Math.floor(pcm.length / 2), Math.round(clip.durationSeconds * sr));
  const offset = Math.round((clip.startSeconds - rangeStart) * sr);
  const total = dest.length / 2;
  const first = Math.max(firstFrame, -offset);
  for (let b = Math.floor(first / BLOCK) * BLOCK; b < frames; b += BLOCK) {
    const g0 = clipGainAt(clip, b / sr);
    const g1 = clipGainAt(clip, Math.min(frames, b + BLOCK) / sr);
    const end = Math.min(frames, b + BLOCK);
    for (let i = Math.max(b, first); i < end; i++) {
      const o = offset + i;
      if (o >= total) return;
      let g = g0 + ((g1 - g0) * (i - b)) / BLOCK;
      if (extraGain) g *= extraGain(o);
      const sample = (i - firstFrame) * 2;
      dest[o * 2] += pcm[sample] * g;
      dest[o * 2 + 1] += pcm[sample + 1] * g;
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

/** Keep gain interpolation on the original clip's block boundaries across adjacent windows. */
function decodeWindow(clip: AudioClipPlan, rangeStart: number, rangeFrames: number) {
  const sr = MIX_SAMPLE_RATE;
  const offset = Math.round((clip.startSeconds - rangeStart) * sr);
  const start = Math.max(0, Math.floor(-offset / BLOCK) * BLOCK);
  const end = Math.min(Math.round(clip.durationSeconds * sr), Math.ceil((rangeFrames - offset) / BLOCK) * BLOCK);
  return { start, count: Math.max(0, end - start) };
}

/** Render the timeline's audio to stereo PCM: per-clip decode and time-stretch in ffmpeg, mixing, ducking and limiting here. */
export async function renderAudioMix(project: Project, opts: MixOptions = {}): Promise<MixResult> {
  const sr = MIX_SAMPLE_RATE;
  const start = Math.max(0, opts.startSeconds ?? 0);
  const end = Math.max(start, Math.min(opts.endSeconds ?? Infinity, compositionDuration(project)));
  const duration = end - start;
  const warnings: string[] = [];
  const plan = buildAudioPlan(project);
  const inRange = (clip: AudioClipPlan, from: number) => clip.startSeconds < end && clip.startSeconds + clip.durationSeconds > from;
  const clips = plan.filter((c) => inRange(c, start));
  // Warm the ducking envelope by up to five time constants. Its remaining error decays
  // below 1%, and aligning to 10 ms keeps detector blocks consistent between windows.
  const history = opts.playbackWindow ? clips.reduce((max, clip) => !clip.isVoice && clip.ducking.enabled
    ? Math.max(max, 5 * Math.max(clip.ducking.attackSeconds, clip.ducking.releaseSeconds)) : max, 0) : 0;
  const voiceStart = history > 0 ? Math.max(0, Math.floor((start - history) * 100) / 100) : start;
  const prerollFrames = Math.round((start - voiceStart) * sr);
  const other = new Float32Array(Math.round(duration * sr) * 2);
  const voice = new Float32Array(other.length + prerollFrames * 2);

  const addClip = async (clip: AudioClipPlan, dest: Float32Array, rangeStart: number, extraGain?: (frame: number) => number) => {
    if (!fs.existsSync(clip.path)) {
      warnings.push(`Missing media for ${clip.elementId}: ${clip.path}`);
      return;
    }
    try {
      const window = opts.playbackWindow ? decodeWindow(clip, rangeStart, dest.length / 2) : undefined;
      if (window && window.count === 0) return;
      const direct = window && !clip.reversed && clip.segments.length === 1 && clip.segments[0].rate === 1
        && (!clip.voiceEnhance.enabled || (!clip.voiceEnhance.reduceNoise && !clip.voiceEnhance.enhanceVoice));
      // Ordinary forward playback can seek straight to this range, with a short decode
      // lead-in for resampling. Stateful filters still see the original clip's prefix.
      const lead = direct ? Math.min(window.start, Math.round(sr * 0.1)) : 0;
      const skipped = direct ? (window.start - lead) / sr : 0;
      const count = window ? window.count : 0;
      const pcm = await decodePcm(clip.path, {
        startSeconds: clip.sourceInSourceSeconds + skipped,
        durationSeconds: Math.max(0, Math.min(clip.sourceDurationSourceSeconds - skipped, direct ? (count + lead) / sr : Infinity)),
        sampleRate: sr,
        channels: 2,
        signal: opts.signal,
        outputSamples: direct ? { start: lead, count } : window,
        ...clipFilterGraph(clip),
      });
      place(dest, pcm, clip, rangeStart, extraGain, window?.start);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      warnings.push(`Could not decode audio for ${clip.elementId}: ${(e as Error).message}`);
    }
  };

  const limit = opts.concurrency ?? 6;
  await pool(plan.filter((c) => c.isVoice && inRange(c, voiceStart)), limit, (clip) => addClip(clip, voice, voiceStart));
  await pool(clips.filter((c) => !c.isVoice), limit, async (clip) => {
    const duck = clip.ducking.enabled ? duckGain(voice, clip) : undefined;
    await addClip(clip, other, start, duck ? (frame) => duck(frame + prerollFrames) : undefined);
  });

  // Sum buses and soft-limit peaks above -0.5 dBFS.
  const t = 0.944;
  for (let i = 0; i < other.length; i++) {
    const x = other[i] + voice[i + prerollFrames * 2];
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
