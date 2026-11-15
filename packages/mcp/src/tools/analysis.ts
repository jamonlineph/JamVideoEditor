import { z } from "zod";
import { EditError, mainElementAt, setAutoBeatMarkers } from "@openedits/core";
import { detectChords, detectHums, detectOnsets, downsampleEnvelope, findPauses, levelStats, octaveBands, quietPoint, rmsEnvelope, type AudioTarget, type LoadedAudio } from "@openedits/engine";
import { defineTool, type ToolContext } from "../defineTool.js";
import { expectedVersion, mutate, round } from "./common.js";

const target = {
  elementId: z.string().optional().describe("Analyze this element's source audio; times are reported in timeline seconds"),
  mediaId: z.string().optional().describe("Analyze a media file; times are reported in source seconds"),
  path: z.string().optional().describe("Analyze any audio/video file by path (source seconds)"),
  from: z.number().min(0).optional().describe("Range start (timeline seconds for an element or the mix; source seconds for media)"),
  to: z.number().min(0).optional().describe("Range end"),
};
const TARGET_NOTE = "Target: elementId, mediaId or path; with none of them, the whole timeline mix is analyzed.";

function toTarget(a: { elementId?: string; mediaId?: string; path?: string; from?: number; to?: number }): AudioTarget {
  return { elementId: a.elementId, mediaId: a.mediaId, path: a.path, startSeconds: a.from, endSeconds: a.to };
}

function describe(loaded: LoadedAudio) {
  return { target: loaded.description, timeBase: loaded.timeBase, durationSeconds: round(loaded.durationSeconds, 3) };
}

/** Map a [start, end] span in buffer seconds to the output time base (reversed elements flip). */
function span(loaded: LoadedAudio, start: number, end: number) {
  const a = loaded.toOutput(start);
  const b = loaded.toOutput(end);
  return { start: round(Math.min(a, b), 4), end: round(Math.max(a, b), 4) };
}

const DENSITY_STEP: Record<string, number> = { lowest: 4, low: 2, medium: 1, high: 0.5, extreme: 0.25 };

export const analysisTools = [
  defineTool({
    name: "loudness",
    title: "Loudness",
    category: "audio",
    description: `Integrated loudness (LUFS, ITU-R BS.1770), loudness range and true peak. ${TARGET_NOTE} Elements and media are measured before clip volume; the timeline mix includes volumes, fades and ducking.`,
    input: z.object(target),
    readOnly: true,
    handler: (a, ctx) => ctx.host.audio.loudness(toTarget(a)),
  }),
  defineTool({
    name: "audioLevels",
    title: "Audio levels",
    category: "audio",
    description: `RMS envelope in dBFS with peak, noise floor, speech level and a suggested silence threshold. ${TARGET_NOTE}`,
    input: z.object({ ...target, maxPoints: z.number().int().min(10).max(2000).optional().describe("Envelope points to return (default 200)") }),
    readOnly: true,
    handler: async (a, ctx) => {
      const loaded = await ctx.host.audio.load(toTarget(a), 16000);
      const env = rmsEnvelope(loaded.pcm, loaded.sampleRate);
      const stats = levelStats(loaded.pcm, env);
      const small = downsampleEnvelope(env, a.maxPoints ?? 200);
      return {
        ...describe(loaded),
        peakDb: round(stats.peakDb, 2),
        rmsDb: round(stats.rmsDb, 2),
        noiseFloorDb: round(stats.noiseFloorDb, 2),
        speechLevelDb: round(stats.speechLevelDb, 2),
        silenceThresholdDb: round(stats.silenceThresholdDb, 2),
        activeRatio: round(stats.activeRatio, 3),
        envelope: { startTime: round(loaded.toOutput(0), 4), hopSeconds: round(small.hopSeconds, 4), rmsDb: small.db },
      };
    },
  }),
  defineTool({
    name: "findPauses",
    title: "Find pauses",
    category: "audio",
    description: `Silences of at least minSilenceSeconds (default from settings, 0.35 s). The threshold is derived from the noise floor unless thresholdDb is given. ${TARGET_NOTE}`,
    input: z.object({ ...target, minSilenceSeconds: z.number().min(0.05).max(30).optional(), thresholdDb: z.number().min(-120).max(0).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const loaded = await ctx.host.audio.load(toTarget(a), 16000);
      const env = rmsEnvelope(loaded.pcm, loaded.sampleRate);
      const stats = levelStats(loaded.pcm, env);
      const threshold = a.thresholdDb ?? stats.silenceThresholdDb;
      const min = a.minSilenceSeconds ?? ctx.host.settings.minSilenceSeconds;
      const pauses = findPauses(env, threshold, min, loaded.durationSeconds).map((p) => ({ ...span(loaded, p.start, p.end), duration: round(p.duration, 4) }));
      pauses.sort((x, y) => x.start - y.start);
      return { ...describe(loaded), thresholdDb: round(threshold, 2), minSilenceSeconds: min, noiseFloorDb: round(stats.noiseFloorDb, 2), speechLevelDb: round(stats.speechLevelDb, 2), count: pauses.length, totalSilenceSeconds: round(pauses.reduce((s, p) => s + p.duration, 0), 3), pauses };
    },
  }),
  defineTool({
    name: "quietPoint",
    title: "Quiet point",
    category: "audio",
    description: "The quietest 10 ms within ±windowSeconds of a timeline time: the cleanest place to cut dialogue. Uses elementId, or the main-track clip under `time`, or the timeline mix.",
    input: z.object({ time: z.number().min(0), windowSeconds: z.number().min(0.02).max(5).optional(), elementId: z.string().optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const window = a.windowSeconds ?? 0.25;
      const project = ctx.host.project;
      let elementId = a.elementId;
      if (!elementId) {
        const el = mainElementAt(project, a.time);
        if (el && el.type === "video" && project.media[el.mediaId]?.hasAudio && !el.audioDetached) elementId = el.id;
      }
      const from = Math.max(0, a.time - window);
      const to = a.time + window;
      const loaded = await ctx.host.audio.load({ elementId, startSeconds: from, endSeconds: to }, 48000);
      // Where the requested time sits inside the decoded buffer.
      let center = loaded.durationSeconds / 2;
      if (loaded.durationSeconds > 0) {
        const t0 = loaded.toOutput(0);
        const t1 = loaded.toOutput(loaded.durationSeconds);
        if (Math.abs(t1 - t0) > 1e-9) center = ((a.time - t0) / (t1 - t0)) * loaded.durationSeconds;
      }
      const q = quietPoint(loaded.pcm, loaded.sampleRate, Math.max(0, Math.min(loaded.durationSeconds, center)), window * (loaded.durationSeconds / Math.max(1e-9, to - from)));
      const time = loaded.toOutput(q.time);
      return { ...describe(loaded), requestedTime: a.time, time: round(time, 4), offsetSeconds: round(time - a.time, 4), rmsDb: round(q.rmsDb, 2), ...(elementId ? { elementId } : {}) };
    },
  }),
  defineTool({
    name: "audioOnsets",
    title: "Audio onsets",
    category: "audio",
    description: `Transient hits, tempo (BPM) and a beat grid. addBeatMarkers writes the beats as auto beat markers thinned by the project's beat density (one undo step). ${TARGET_NOTE}`,
    input: z.object({ ...target, addBeatMarkers: z.boolean().optional(), maxOnsets: z.number().int().min(1).max(5000).optional(), expectedVersion }),
    handler: async (a, ctx) => {
      const loaded = await ctx.host.audio.load(toTarget(a), 22050);
      const r = detectOnsets(loaded.pcm, loaded.sampleRate);
      const onsets = r.onsets.map((o) => ({ time: round(loaded.toOutput(o.time), 4), strength: round(o.strength, 3) })).sort((x, y) => x.time - y.time);
      const beats = r.beats.map((b) => round(loaded.toOutput(b), 4)).sort((x, y) => x - y);
      const base = { ...describe(loaded), bpm: r.bpm, bpmConfidence: round(r.bpmConfidence, 3), onsetCount: onsets.length, onsets: onsets.slice(0, a.maxOnsets ?? 500), beats };
      if (!a.addBeatMarkers) return base;
      if (loaded.timeBase !== "timeline") throw new EditError("INVALID_ARGUMENT", "addBeatMarkers needs timeline times: analyze an element on the timeline (constant speed) or the mix");
      if (!beats.length) return { ...base, markersAdded: 0, warnings: ["No steady beat was found, so no markers were added"] };
      const density = ctx.host.project.beatDensity === "off" ? "medium" : ctx.host.project.beatDensity;
      const step = DENSITY_STEP[density];
      const period = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
      const marks: { timeSeconds: number; strength: number }[] = [];
      if (step >= 1) beats.forEach((t, i) => i % step === 0 && marks.push({ timeSeconds: t, strength: i % 4 === 0 ? 1 : 0.6 }));
      else for (const t of beats) for (let k = 0; k < 1 / step; k++) marks.push({ timeSeconds: t + k * period * step, strength: k === 0 ? 1 : 0.4 });
      const res = mutate(ctx, "Detect beats", (c) => setAutoBeatMarkers(c, marks), { expectedVersion: a.expectedVersion, skipFinalize: true }, (n) => ({ markersAdded: n, density }));
      return { ...base, ...res };
    },
  }),
  defineTool({
    name: "audioChords",
    title: "Audio chords",
    category: "audio",
    description: `Major/minor chord segments from a 12-bin chromagram ("N" = no chord). Best on music without heavy percussion. ${TARGET_NOTE}`,
    input: z.object(target),
    readOnly: true,
    handler: async (a, ctx) => {
      const loaded = await ctx.host.audio.load(toTarget(a), 22050);
      const chords = detectChords(loaded.pcm, loaded.sampleRate).map((c) => ({ ...span(loaded, c.start, c.end), chord: c.chord, confidence: c.confidence }));
      chords.sort((x, y) => x.start - y.start);
      return { ...describe(loaded), chords };
    },
  }),
  defineTool({
    name: "audioSpectrum",
    title: "Audio spectrum",
    category: "audio",
    description: `Detects steady narrow-band noise (mains hum and harmonics, electrical whine) and reports octave-band levels. Feed the frequencies to processAudio removeHum. ${TARGET_NOTE}`,
    input: z.object(target),
    readOnly: true,
    handler: async (a, ctx) => {
      const loaded = await ctx.host.audio.load(toTarget(a), 32000);
      // The mix is 48 kHz; either rate resolves mains hum to within a couple of Hz.
      return { ...describe(loaded), hums: detectHums(loaded.pcm, loaded.sampleRate), octaveBandsDb: octaveBands(loaded.pcm, loaded.sampleRate) };
    },
  }),
  defineTool({
    name: "processAudio",
    title: "Process audio",
    category: "audio",
    description: "Offline audio cleanup written to a new lossless file: parametric EQ, high/low-pass, hum removal (auto-detected or given frequencies), denoise, voice isolation (speech-band filter + denoise + gate, not a learned model) and LUFS normalization. With elementId the result replaces that element's audio (videos get a linked audio element) as one undo step.",
    input: z.object({
      elementId: z.string().optional(),
      mediaId: z.string().optional(),
      eq: z.array(z.object({ frequencyHz: z.number().min(20).max(20000), gainDb: z.number().min(-24).max(24), q: z.number().min(0.1).max(20).optional() })).max(12).optional(),
      highpassHz: z.number().min(20).max(2000).optional(),
      lowpassHz: z.number().min(500).max(20000).optional(),
      removeHum: z.union([z.boolean(), z.array(z.number().min(20).max(16000)).max(8)]).optional(),
      denoise: z.number().min(0).max(100).optional(),
      voiceIsolation: z.boolean().optional(),
      normalizeLufs: z.number().min(-40).max(-5).optional().describe("Target integrated loudness, e.g. -14 for social video"),
      expectedVersion,
    }),
    handler: async ({ expectedVersion: ev, ...a }, ctx: ToolContext) => {
      const r = await ctx.host.audio.process({ ...a, source: ctx.source, expectedVersion: ev });
      return {
        ok: true,
        version: r.commit.version,
        undoLabel: r.commit.noop ? null : r.commit.label,
        changed: r.commit.changed,
        mediaId: r.mediaId,
        path: r.path,
        ...(r.audioElementId ? { audioElementId: r.audioElementId } : {}),
        applied: r.applied,
        ...(r.humFrequenciesHz.length ? { humFrequenciesHz: r.humFrequenciesHz } : {}),
        loudnessBefore: r.before,
        loudnessAfter: r.after,
      };
    },
  }),
];
