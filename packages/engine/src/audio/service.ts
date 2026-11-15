import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EditError,
  addMediaAssets,
  extractAudio,
  replaceElementMedia,
  requireElement,
  sourceTimeAt,
  timelineTimeOfSource,
  type MediaAsset,
} from "@openedits/core";
import type { EngineHost } from "../host.js";
import { decodePcm, runFfmpeg, writeWav } from "../ffmpeg.js";
import { detectHums } from "./dsp.js";
import { renderAudioMix, toMono } from "./mix.js";

export interface AudioTarget {
  /** Analyze this element's source window; results are reported in timeline seconds. */
  elementId?: string;
  /** Analyze a media file; results are in source seconds. */
  mediaId?: string;
  path?: string;
  /** Optional range: timeline seconds for elements / the mix, source seconds for media. */
  startSeconds?: number;
  endSeconds?: number;
}

export interface LoadedAudio {
  pcm: Float32Array;
  sampleRate: number;
  /** Time base of values returned by `toOutput`. */
  timeBase: "timeline" | "source";
  /** Map seconds-from-buffer-start to the reported time base. */
  toOutput(seconds: number): number;
  durationSeconds: number;
  description: string;
  /** The file range that was decoded (absent for the timeline mix). */
  file?: { path: string; startSeconds: number; durationSeconds: number };
}

export interface Loudness {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
}

export interface ProcessAudioOptions {
  elementId?: string;
  mediaId?: string;
  highpassHz?: number;
  lowpassHz?: number;
  eq?: { frequencyHz: number; gainDb: number; q?: number }[];
  /** true = detect steady tones and notch them; or explicit frequencies in Hz. */
  removeHum?: boolean | number[];
  /** 0..100 */
  denoise?: number;
  voiceIsolation?: boolean;
  /** Target integrated loudness, e.g. -14. */
  normalizeLufs?: number;
  source: string;
  expectedVersion?: number;
}

function parseLoudness(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  return {
    integratedLufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/),
    loudnessRangeLu: num(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDbtp: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/),
  };
}

export class AudioService {
  constructor(private readonly host: EngineHost) {}

  private cacheDir(sub: string): string {
    const dir = path.join(this.host.projectDirPath, "cache", sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private mediaFor(target: { mediaId?: string; path?: string }): { path: string; duration?: number; name: string } {
    if (target.mediaId) {
      const m = this.host.project.media[target.mediaId];
      if (!m) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${target.mediaId}"`);
      if (!m.hasAudio) throw new EditError("UNSUPPORTED_MEDIA", `${m.name} has no audio`);
      return { path: m.path, duration: m.durationSourceSeconds, name: m.name };
    }
    const p = path.resolve(target.path!.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(p)) throw new EditError("FILE_NOT_FOUND", `File not found: ${p}`, { path: p });
    return { path: p, name: path.basename(p) };
  }

  /** Decode the audio a tool should analyze, with a mapping back to timeline or source time. */
  async load(target: AudioTarget, sampleRate: number): Promise<LoadedAudio> {
    const project = this.host.project;
    if (target.elementId) {
      const el = requireElement(project, target.elementId);
      if (el.type !== "video" && el.type !== "audio") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} (${el.type}) has no audio`);
      const media = project.media[el.mediaId];
      if (!media?.hasAudio) throw new EditError("UNSUPPORTED_MEDIA", `Media for ${el.id} has no audio`);
      const t0 = Math.max(el.start, target.startSeconds ?? el.start);
      const t1 = Math.min(el.start + el.duration, target.endSeconds ?? Infinity);
      if (t1 <= t0) throw new EditError("INVALID_RANGE", `Range does not overlap element ${el.id}`);
      const s0 = sourceTimeAt(project, el, t0);
      const s1 = sourceTimeAt(project, el, t1);
      const srcStart = Math.min(s0, s1);
      const srcDur = Math.abs(s1 - s0);
      const pcm = await decodePcm(media.path, { startSeconds: srcStart, durationSeconds: srcDur, sampleRate, channels: 1 });
      const constant = el.speed.mode === "constant";
      return {
        pcm,
        sampleRate,
        timeBase: constant ? "timeline" : "source",
        toOutput: (sec) => (constant ? timelineTimeOfSource(el, srcStart + sec) ?? (el.reversed ? t0 : t1) : srcStart + sec),
        durationSeconds: pcm.length / sampleRate,
        description: `element ${el.id} (${media.name})${constant ? "" : "; speed curve, so times are source seconds"}`,
        file: { path: media.path, startSeconds: srcStart, durationSeconds: srcDur },
      };
    }
    if (target.mediaId || target.path) {
      const m = this.mediaFor(target);
      const start = Math.max(0, target.startSeconds ?? 0);
      const dur = target.endSeconds !== undefined ? Math.max(0, target.endSeconds - start) : m.duration !== undefined ? Math.max(0, m.duration - start) : undefined;
      const pcm = await decodePcm(m.path, { startSeconds: start, durationSeconds: dur, sampleRate, channels: 1 });
      return {
        pcm,
        sampleRate,
        timeBase: "source",
        toOutput: (sec) => start + sec,
        durationSeconds: pcm.length / sampleRate,
        description: `media ${m.name}`,
        file: { path: m.path, startSeconds: start, durationSeconds: dur ?? pcm.length / sampleRate },
      };
    }
    const mix = await renderAudioMix(project, { startSeconds: target.startSeconds, endSeconds: target.endSeconds });
    return {
      pcm: toMono(mix.samples),
      sampleRate: mix.sampleRate,
      timeBase: "timeline",
      toOutput: (sec) => mix.startSeconds + sec,
      durationSeconds: mix.durationSeconds,
      description: `timeline mix (${mix.clipCount} clips)`,
    };
  }

  async measureFile(file: string, range?: { startSeconds: number; durationSeconds: number }): Promise<Loudness> {
    const args: string[] = [];
    if (range && range.startSeconds > 0) args.push("-ss", range.startSeconds.toFixed(6));
    if (range) args.push("-t", range.durationSeconds.toFixed(6));
    args.push("-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-");
    const { stderr } = await runFfmpeg(args);
    return parseLoudness(stderr);
  }

  /** EBU R128 / ITU-R BS.1770 loudness of an element's source audio, a media file, or the timeline mix. */
  async loudness(target: AudioTarget): Promise<Loudness & { target: string; durationSeconds: number }> {
    if (target.elementId || target.mediaId || target.path) {
      const loaded = await this.load(target, 8000);
      return { ...(await this.measureFile(loaded.file!.path, loaded.file)), target: loaded.description, durationSeconds: loaded.file!.durationSeconds };
    }
    const mix = await renderAudioMix(this.host.project, { startSeconds: target.startSeconds, endSeconds: target.endSeconds });
    const wav = path.join(this.cacheDir("audio"), `loudness-${process.pid}-${Date.now()}.wav`);
    writeWav(wav, mix.samples, mix.sampleRate, 2);
    try {
      return { ...(await this.measureFile(wav)), target: `timeline mix (${mix.clipCount} clips)`, durationSeconds: mix.durationSeconds };
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  /** Offline processing chain. Writes a lossless FLAC next to the project and (for elements) swaps it in as one undo step. */
  async process(opts: ProcessAudioOptions) {
    const host = this.host;
    const project = host.project;
    let media: MediaAsset;
    if (opts.elementId) {
      const el = requireElement(project, opts.elementId);
      if (el.type !== "video" && el.type !== "audio") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} (${el.type}) has no audio`);
      media = project.media[el.mediaId];
    } else if (opts.mediaId) {
      media = project.media[opts.mediaId];
      if (!media) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${opts.mediaId}"`);
    } else throw new EditError("INVALID_ARGUMENT", "Provide elementId or mediaId");
    if (!media?.hasAudio) throw new EditError("UNSUPPORTED_MEDIA", "The target has no audio stream");

    const chain: string[] = [];
    const applied: string[] = [];
    let hums: number[] = [];
    if (opts.removeHum) {
      if (Array.isArray(opts.removeHum)) hums = opts.removeHum;
      else {
        const pcm = await decodePcm(media.path, { durationSeconds: 120, sampleRate: 32000, channels: 1 });
        hums = detectHums(pcm, 32000).map((h) => h.frequencyHz);
      }
      for (const f of hums.slice(0, 8)) chain.push(`bandreject=f=${f}:t=q:w=${Math.max(8, f / 4).toFixed(1)}`);
      applied.push(hums.length ? `hum notch at ${hums.slice(0, 8).join(", ")} Hz` : "hum removal requested but no steady tone was found");
    }
    if (opts.voiceIsolation) {
      chain.push("highpass=f=90", "lowpass=f=7500", "afftdn=nr=24:nf=-28", "agate=threshold=0.015:ratio=3:attack=5:release=150");
      applied.push("voice isolation (speech-band filter, spectral denoise and gate; not a learned separation model)");
    }
    if (opts.highpassHz) {
      chain.push(`highpass=f=${opts.highpassHz}`);
      applied.push(`highpass ${opts.highpassHz} Hz`);
    }
    if (opts.lowpassHz) {
      chain.push(`lowpass=f=${opts.lowpassHz}`);
      applied.push(`lowpass ${opts.lowpassHz} Hz`);
    }
    if (opts.denoise && !opts.voiceIsolation) {
      chain.push(`afftdn=nr=${Math.max(0.5, opts.denoise * 0.4).toFixed(1)}:nf=-30`);
      applied.push(`denoise ${opts.denoise}`);
    }
    for (const band of opts.eq ?? []) {
      chain.push(`equalizer=f=${band.frequencyHz}:t=q:w=${band.q ?? 1}:g=${band.gainDb}`);
      applied.push(`EQ ${band.gainDb > 0 ? "+" : ""}${band.gainDb} dB at ${band.frequencyHz} Hz`);
    }
    if (!chain.length && opts.normalizeLufs === undefined) throw new EditError("INVALID_ARGUMENT", "Nothing to do: pass at least one of eq, highpassHz, lowpassHz, removeHum, denoise, voiceIsolation, normalizeLufs");

    const hash = createHash("sha1").update(JSON.stringify([media.path, media.sizeBytes, chain, opts.normalizeLufs ?? null])).digest("hex").slice(0, 10);
    const out = path.join(this.cacheDir("audio"), `${path.parse(media.name).name}-processed-${hash}.flac`);
    const before = await this.measureFile(media.path);
    if (opts.normalizeLufs !== undefined) {
      const target = `I=${opts.normalizeLufs}:TP=-1.5:LRA=11`;
      const first = await runFfmpeg(["-i", media.path, "-vn", "-af", [...chain, `loudnorm=${target}:print_format=json`].join(","), "-f", "null", "-"]);
      const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(first.stderr);
      if (!json) throw new EditError("INTERNAL", "Could not read loudness measurement from ffmpeg");
      const m = JSON.parse(json[0]) as Record<string, string>;
      if (m.input_i === "-inf") throw new EditError("UNSUPPORTED_MEDIA", "The audio is silent; nothing to normalize");
      chain.push(`loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`);
      applied.push(`loudness normalized to ${opts.normalizeLufs} LUFS`);
    }
    await runFfmpeg(["-y", "-i", media.path, "-vn", "-af", chain.join(","), "-ar", "48000", "-c:a", "flac", out]);
    const after = await this.measureFile(out);
    const probe = await host.prober(out);
    const existing = Object.values(project.media).find((x) => x.path === out);
    const asset: MediaAsset = existing ?? { id: host.ids("med"), name: `${path.parse(media.name).name} (processed).flac`, path: out, importedAt: host.now(), ...probe };

    const res = host.mutate("Process audio", opts.source, (ctx) => {
      if (!existing) addMediaAssets(ctx, [asset]);
      if (!opts.elementId) return null;
      const el = requireElement(ctx.draft, opts.elementId);
      if (el.type === "audio") {
        replaceElementMedia(ctx, el, ctx.draft.media[asset.id]);
        return el.id;
      }
      if (el.type !== "video") return null;
      const linked = el.audioDetached && el.linkedAudioId ? ctx.draft.elements[el.linkedAudioId] : undefined;
      const audio = linked && linked.type === "audio" ? linked : extractAudio(ctx, el);
      replaceElementMedia(ctx, audio, ctx.draft.media[asset.id]);
      return audio.id;
    }, { expectedVersion: opts.expectedVersion });
    return { commit: res, mediaId: asset.id, path: out, audioElementId: res.result, applied, humFrequenciesHz: hums, before, after };
  }
}
