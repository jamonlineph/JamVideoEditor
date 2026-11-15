import { describe, expect, it } from "vitest";
import { detectChords, detectHums, detectOnsets, fft, findPauses, levelStats, octaveBands, quietPoint, rmsEnvelope } from "../src/audio/dsp.js";

const SR = 16000;

/** Deterministic noise. */
function rng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

function synth(seconds: number, sr: number, fn: (t: number, i: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / sr, i);
  return out;
}

describe("fft", () => {
  it("finds a sine's bin and magnitude", () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 32 * i) / n);
    fft(re, im);
    const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    expect(mags.indexOf(Math.max(...mags.slice(0, n / 2)))).toBe(32);
    expect(mags[32]).toBeCloseTo(n / 2, 6);
    expect(mags[10]).toBeLessThan(1e-9);
  });
});

describe("levels and pauses", () => {
  // "Speech" (tone bursts at -14 dBFS) with room noise at about -60 dBFS; gaps at 1.0-1.6 s and 2.5-2.7 s.
  const noise = rng();
  const speaking = (t: number) => !(t >= 1.0 && t < 1.6) && !(t >= 2.5 && t < 2.7) && t < 3.5;
  const pcm = synth(4, SR, (t) => noise() * 0.002 + (speaking(t) ? 0.28 * Math.sin(2 * Math.PI * 220 * t) : 0));
  const env = rmsEnvelope(pcm, SR);
  const stats = levelStats(pcm, env);

  it("measures noise floor, programme level and peak", () => {
    expect(stats.speechLevelDb).toBeCloseTo(-14.1, 0);
    expect(stats.noiseFloorDb).toBeLessThan(-55);
    expect(stats.peakDb).toBeGreaterThan(-12);
    expect(stats.silenceThresholdDb).toBeGreaterThan(stats.noiseFloorDb);
    expect(stats.silenceThresholdDb).toBeLessThan(stats.speechLevelDb - 10);
    expect(stats.activeRatio).toBeCloseTo((4 - 0.6 - 0.2 - 0.5) / 4, 1);
  });

  it("finds pauses longer than the minimum, to within 20 ms", () => {
    const pauses = findPauses(env, stats.silenceThresholdDb, 0.35, 4);
    expect(pauses.length).toBe(2);
    expect(pauses[0].start).toBeCloseTo(1.0, 1);
    expect(Math.abs(pauses[0].start - 1.0)).toBeLessThan(0.02);
    expect(Math.abs(pauses[0].end - 1.6)).toBeLessThan(0.02);
    expect(pauses[1].start).toBeCloseTo(3.5, 1);
    expect(pauses[1].end).toBe(4);
    expect(findPauses(env, stats.silenceThresholdDb, 0.15, 4).length).toBe(3);
  });

  it("a steady tone has no pauses", () => {
    const tone = synth(2, SR, (t) => 0.3 * Math.sin(2 * Math.PI * 440 * t));
    const e = rmsEnvelope(tone, SR);
    expect(findPauses(e, levelStats(tone, e).silenceThresholdDb, 0.2, 2)).toEqual([]);
  });

  it("quietPoint lands inside the nearest gap", () => {
    const q = quietPoint(pcm, SR, 2.45, 0.25);
    expect(q.time).toBeGreaterThan(2.5);
    expect(q.time).toBeLessThan(2.7);
    expect(q.rmsDb).toBeLessThan(-55);
    // With true digital silence everywhere nearby, it stays at the requested time.
    const silent = new Float32Array(SR);
    expect(quietPoint(silent, SR, 0.5, 0.2).time).toBeCloseTo(0.5, 2);
  });
});

describe("onsets and tempo", () => {
  it("detects clicks at 120 BPM", () => {
    const sr = 22050;
    const noise = rng(7);
    const pcm = synth(8, sr, (t) => {
      const phase = t % 0.5;
      return phase < 0.03 ? noise() * 1.6 * Math.exp(-phase * 150) : 0;
    });
    const r = detectOnsets(pcm, sr);
    expect(r.onsets.length).toBeGreaterThanOrEqual(14);
    expect(r.onsets.length).toBeLessThanOrEqual(17);
    expect(r.bpm).toBeGreaterThan(118);
    expect(r.bpm).toBeLessThan(122);
    // Each onset is within 25 ms of a click.
    for (const o of r.onsets) expect(Math.min(o.time % 0.5, 0.5 - (o.time % 0.5))).toBeLessThan(0.025);
    const gaps = r.beats.slice(1).map((b, i) => b - r.beats[i]);
    expect(gaps.every((g) => Math.abs(g - 0.5) < 0.02)).toBe(true);
  });

  it("finds the beat under a steady tone but no tempo in the tone alone", () => {
    const sr = 22050;
    const noise = rng(11);
    const tone = synth(8, sr, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.003 * noise()));
    const r = detectOnsets(tone, sr);
    expect(r.bpm).toBeNull();
    expect(r.onsets.length).toBeLessThanOrEqual(1);
    const withClicks = synth(8, sr, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * t) + ((t % 0.5) < 0.03 ? noise() * 0.8 * Math.exp(-(t % 0.5) * 150) : 0));
    const r2 = detectOnsets(withClicks, sr);
    expect(r2.bpm).toBeGreaterThan(118);
    expect(r2.bpm).toBeLessThan(122);
  });

  it("reports no tempo for silence", () => {
    const r = detectOnsets(new Float32Array(22050 * 2), 22050);
    expect(r).toEqual({ onsets: [], bpm: null, bpmConfidence: 0, beats: [] });
  });
});

describe("hum detection", () => {
  it("finds 60 Hz mains hum and its harmonic under noise, and ignores speech-like bursts", () => {
    const sr = 32000;
    const noise = rng(3);
    const pcm = synth(6, sr, (t) => noise() * 0.02 + 0.05 * Math.sin(2 * Math.PI * 60 * t) + 0.02 * Math.sin(2 * Math.PI * 120 * t) + (Math.floor(t * 2) % 2 ? 0.2 * Math.sin(2 * Math.PI * 700 * t) : 0));
    const hums = detectHums(pcm, sr);
    const f = hums.map((h) => Math.round(h.frequencyHz));
    expect(f).toContain(60);
    expect(f).toContain(120);
    expect(hums.find((h) => Math.round(h.frequencyHz) === 60)!.label).toBe("mains hum (60 Hz)");
    expect(hums.every((h) => h.persistence >= 0.75)).toBe(true);
    expect(f).not.toContain(700);
    expect(detectHums(synth(4, sr, () => noise() * 0.05), sr)).toEqual([]);
  });

  it("octave bands locate a 1 kHz tone", () => {
    const bands = octaveBands(synth(2, SR, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t)), SR);
    const top = [...bands].sort((a, b) => b.db - a.db)[0];
    expect(top.centerHz).toBe(1000);
    expect(top.db).toBeGreaterThan(-12);
  });
});

describe("chords", () => {
  const sr = 22050;
  const triad = (freqs: number[]) => (t: number) => freqs.reduce((acc, f) => acc + 0.2 * Math.sin(2 * Math.PI * f * t) + 0.08 * Math.sin(2 * Math.PI * 2 * f * t), 0);
  it("recognises C major then A minor", () => {
    const c = triad([261.63, 329.63, 392.0]);
    const am = triad([220.0, 261.63, 329.63]);
    const pcm = synth(8, sr, (t) => (t < 4 ? c(t) : am(t)));
    const chords = detectChords(pcm, sr).filter((s) => s.end - s.start > 0.5);
    expect(chords.map((s) => s.chord)).toEqual(["C", "Am"]);
    expect(chords[0].end).toBeCloseTo(4, 0);
    expect(chords[0].confidence).toBeGreaterThan(0.9);
  });
  it("returns N for silence", () => {
    expect(detectChords(new Float32Array(sr * 2), sr).every((s) => s.chord === "N")).toBe(true);
  });
});
