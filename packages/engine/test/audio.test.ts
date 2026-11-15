import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMediaToTimeline, setDucking, setFade, setReversed, setSound, setSpeed, setSpeedCurve, trimElement, type AudioElement } from "@openedits/core";
import { EngineHost, JobManager, atempoChain, clipFilterGraph, levelStats, renderAudioMix, rmsEnvelope, toMono } from "../src/index.js";
import { buildAudioPlan } from "@openedits/core";
import { tempWorkspace, testMedia } from "./media.js";

let host: EngineHost;
let clipA: string;
let music: string;

const rms = (pcm: Float32Array, from: number, to: number, sr = 48000) => {
  let s = 0;
  const a = Math.round(from * sr) * 2;
  const b = Math.round(to * sr) * 2;
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

beforeAll(async () => {
  const m = testMedia();
  host = EngineHost.create({ workspaceRoot: tempWorkspace("audio"), validate: true });
  host.newProject({ name: "Audio" });
  const imp = await host.importMedia([m.clipA, m.music]);
  const r = host.mutate("add", "t", (ctx) => ({
    a: addMediaToTimeline(ctx, ctx.draft.media[imp.assets[0].id], {}).id,
    m: addMediaToTimeline(ctx, ctx.draft.media[imp.assets[1].id], {}).id,
  }));
  clipA = r.result.a;
  music = r.result.m;
});

afterAll(() => host.dispose());

/** Copy of the project with some elements muted (for isolating buses). */
function muted(ids: string[]) {
  const p = host.project;
  const elements = { ...p.elements };
  for (const id of ids) elements[id] = { ...elements[id], muted: true } as (typeof elements)[string];
  return { ...p, elements };
}

const SINE_RMS = 0.125 / Math.SQRT2; // ffmpeg's sine source has amplitude 1/8

describe("audio mix", () => {
  it("mixes clips at their timeline positions with unity gain, volume and fades", async () => {
    const flat = await renderAudioMix(host.project);
    expect(flat.clipCount).toBe(2);
    expect(flat.warnings).toEqual([]);
    expect(flat.durationSeconds).toBeCloseTo(12, 1);
    expect(flat.samples.length).toBe(Math.round(flat.durationSeconds * 48000) * 2);
    // 6..12 s holds only the music, at unity.
    expect(rms(flat.samples, 8, 10)).toBeCloseTo(SINE_RMS, 2);
    // 0..6 s also has the video's tone (different frequency, so powers add).
    expect(rms(flat.samples, 2, 5)).toBeCloseTo(SINE_RMS * Math.SQRT2, 2);
    host.mutate("levels", "t", (ctx) => {
      setSound(ctx, ctx.draft.elements[music], { volume: 0.5 });
      setFade(ctx, ctx.draft.elements[music], { fadeInSeconds: 2 });
    });
    try {
      const musicOnly = await renderAudioMix(muted([clipA]));
      expect(rms(musicOnly.samples, 8, 10)).toBeCloseTo(SINE_RMS / 2, 2);
      expect(rms(musicOnly.samples, 0.95, 1.05) / rms(musicOnly.samples, 8, 10)).toBeCloseTo(0.5, 1);
      const range = await renderAudioMix(host.project, { startSeconds: 7, endSeconds: 9 });
      expect(range.durationSeconds).toBe(2);
      expect(rms(range.samples, 0.5, 1.5)).toBeCloseTo(SINE_RMS / 2, 2);
    } finally {
      host.undo("t");
    }
  });

  it("time-stretches for speed and handles reversed speed curves", async () => {
    host.mutate("speed", "t", (ctx) => setSpeed(ctx, ctx.draft.elements[clipA], 2));
    try {
      expect(host.project.elements[clipA].duration).toBe(3);
      const plan = buildAudioPlan(host.project).find((c) => c.elementId === clipA)!;
      expect(clipFilterGraph(plan).filters).toContain("atempo=2.000000");
      const voice = await renderAudioMix(muted([music]));
      expect(rms(voice.samples, 1, 2.5)).toBeCloseTo(SINE_RMS, 2);
      expect(rms(voice.samples, 3.2, 5)).toBeLessThan(0.001); // the clip now ends at 3 s
      host.mutate("curve", "t", (ctx) => {
        setSpeedCurve(ctx, ctx.draft.elements[clipA], { preset: "RAMP" });
        setReversed(ctx, ctx.draft.elements[clipA], true);
      });
      const curved = buildAudioPlan(host.project).find((c) => c.elementId === clipA)!;
      expect(clipFilterGraph(curved).filterComplex).toMatch(/areverse.*asplit=\d+/);
      const dur = host.project.elements[clipA].duration;
      const curveMix = await renderAudioMix(muted([music]));
      expect(curveMix.warnings).toEqual([]);
      expect(rms(curveMix.samples, 0.5, dur - 0.5)).toBeCloseTo(SINE_RMS, 1);
      expect(rms(curveMix.samples, dur + 0.2, dur + 1)).toBeLessThan(0.001);
      host.undo("t");
    } finally {
      host.undo("t");
    }
  });

  it("ducks music by the requested amount only while the voice is active", async () => {
    host.mutate("setup", "t", (ctx) => {
      trimElement(ctx, ctx.draft.elements[clipA], "right", 3); // voice 0..3 s
      setDucking(ctx, ctx.draft.elements[music], { enabled: true, amountDb: -12, attackSeconds: 0.02, releaseSeconds: 0.05 });
    });
    try {
      const full = await renderAudioMix(host.project);
      const voiceOnly = await renderAudioMix(muted([music]));
      const diff = full.samples.map((v, i) => v - voiceOnly.samples[i]); // what is left is the (ducked) music
      expect(rms(diff, 1, 2.5)).toBeCloseTo(SINE_RMS * Math.pow(10, -12 / 20), 2);
      expect(rms(diff, 5, 8)).toBeCloseTo(SINE_RMS, 2);
    } finally {
      host.undo("t");
    }
  });
});

describe("audio service", () => {
  it("loads element, media and timeline targets with the right time base", async () => {
    const el = await host.audio.load({ elementId: clipA, startSeconds: 1, endSeconds: 3 }, 16000);
    expect(el.timeBase).toBe("timeline");
    expect(el.durationSeconds).toBeCloseTo(2, 1);
    expect(el.toOutput(0.5)).toBeCloseTo(1.5);
    const med = await host.audio.load({ mediaId: host.project.elements[music].type === "audio" ? (host.project.elements[music] as AudioElement).mediaId : "" }, 16000);
    expect(med.timeBase).toBe("source");
    expect(med.durationSeconds).toBeCloseTo(12, 0);
    const tl = await host.audio.load({ startSeconds: 2, endSeconds: 4 }, 16000);
    expect(tl.toOutput(1)).toBe(3);
    const env = rmsEnvelope(toMono(new Float32Array(0)), 48000);
    expect(env.db.length).toBe(0);
    expect(levelStats(tl.pcm, rmsEnvelope(tl.pcm, tl.sampleRate)).rmsDb).toBeGreaterThan(-30);
  });

  it("measures loudness of an element and of the mix", async () => {
    const m = await host.audio.loudness({ elementId: music });
    // A -18.06 dBFS sine at 220 Hz measures close to its RMS level on the LUFS scale.
    expect(m.integratedLufs).toBeGreaterThan(-24);
    expect(m.integratedLufs).toBeLessThan(-17);
    expect(m.truePeakDbtp).toBeGreaterThan(-19.5);
    expect(m.truePeakDbtp).toBeLessThan(-16.5);
    const mix = await host.audio.loudness({});
    expect(mix.integratedLufs).toBeGreaterThan(m.integratedLufs!);
  });

  it("processAudio normalizes loudness and swaps the result in as one undo step", async () => {
    const v = host.session.version;
    const r = await host.audio.process({ elementId: music, normalizeLufs: -14, highpassHz: 60, source: "t" });
    expect(r.after.integratedLufs).toBeCloseTo(-14, 0);
    expect(r.applied.join("; ")).toMatch(/highpass 60 Hz.*normalized to -14 LUFS/);
    expect(host.session.version).toBe(v + 1);
    const el = host.project.elements[music] as AudioElement;
    expect(el.mediaId).toBe(r.mediaId);
    expect(host.project.media[r.mediaId].path.endsWith(".flac")).toBe(true);
    expect(el.duration).toBeCloseTo(12, 1);
    // A video element gets a linked, processed audio element.
    const r2 = await host.audio.process({ elementId: clipA, denoise: 30, source: "t" });
    expect(host.project.elements[r2.audioElementId!].type).toBe("audio");
    expect((host.project.elements[r2.audioElementId!] as AudioElement).linkedVideoId).toBe(clipA);
    host.undo("t");
    host.undo("t");
    expect((host.project.elements[music] as AudioElement).mediaId).not.toBe(r.mediaId);
    await expect(host.audio.process({ elementId: music, source: "t" })).rejects.toThrow(/Nothing to do/);
  });
});

describe("jobs and helpers", () => {
  it("tracks progress, results, failures and cancellation", async () => {
    const jobs = new JobManager();
    const ok = jobs.start("demo", async (ctx) => {
      ctx.progress(0.5, "half");
      return { value: 42 };
    });
    expect((await jobs.wait(ok.id, 1000)).result).toEqual({ value: 42 });
    const bad = jobs.start("demo", async () => {
      throw new Error("nope");
    });
    expect((await jobs.wait(bad.id, 1000)).error?.message).toBe("nope");
    const slow = jobs.start("demo", (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    expect((await jobs.wait(slow.id, 20)).status).toBe("running");
    jobs.cancel(slow.id);
    expect((await jobs.wait(slow.id, 1000)).status).toBe("cancelled");
    expect(jobs.latest("demo")!.id).toBe(slow.id);
    expect(() => jobs.get("job_x")).toThrow(/No job/);
  });

  it("chains atempo for slow rates", () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(2)).toEqual(["atempo=2.000000"]);
    expect(atempoChain(0.2)).toEqual(["atempo=0.5", "atempo=0.5", "atempo=0.800000"]);
  });
});
