import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMediaToTimeline, applyTranscriptOps, mainTrack, normalizeWord, timelineWords } from "@openedits/core";
import { EngineHost, alignWords, chunkBoundaries, dtwPreset, findPauses, levelStats, parseWhisperJson, refineWordBounds, rmsEnvelope, toMono, renderAudioMix } from "../src/index.js";
import { canSpeak, haveWhisper, speechClip, tempWorkspace, testMedia } from "./media.js";

let host: EngineHost;
let mediaId: string;

beforeAll(async () => {
  host = EngineHost.create({ workspaceRoot: tempWorkspace("transcript"), validate: true });
  host.newProject({ name: "Talk" });
  const imp = await host.importMedia([canSpeak ? speechClip() : testMedia().clipA]);
  mediaId = imp.assets[0].id;
  host.mutate("add", "t", (c) => addMediaToTimeline(c, c.draft.media[mediaId], {}));
});
afterAll(() => host.dispose());

const words = () => timelineWords(host.project, host.transcripts.all()).words;
const plain = () => words().map((w) => normalizeWord(w.text)).join(" ");

describe("whisper parsing and word timing", () => {
  it("parses one word per segment and skips non-speech markers", () => {
    const r = parseWhisperJson({
      result: { language: "en" },
      transcription: [
        { text: "", offsets: { from: 0, to: 40 } },
        { text: " Hello", offsets: { from: 40, to: 400 }, tokens: [{ text: " Hello", p: 0.9 }] },
        { text: " [BLANK_AUDIO]", offsets: { from: 400, to: 900 } },
        { text: " world.", offsets: { from: 900, to: 2000 }, tokens: [{ text: " world", p: 0.8, t_dtw: 130 }, { text: ".", p: 1, t_dtw: 190 }, { text: "[_TT_50]", p: 0.01 }] },
      ],
    });
    expect(r.language).toBe("en");
    expect(r.words).toEqual([
      { text: "Hello", start: 0.04, end: 0.4, confidence: 0.9 },
      { text: "world.", start: 0.9, end: 2, confidence: 0.9, anchor: 1.3 },
    ]);
    expect(dtwPreset("/x/ggml-large-v3-turbo-q5_0.bin")).toBe("large.v3.turbo");
    expect(dtwPreset("ggml-base.en.bin")).toBe("base.en");
    expect(dtwPreset("custom-model.bin")).toBeUndefined();
  });

  it("tightens word ends to the audible part", () => {
    const sr = 16000;
    // Speech 0.5-1.0 s, then silence until 2.0 s; whisper says the word runs 0.5-2.0.
    const pcm = new Float32Array(sr * 2.5).map((_, i) => (i / sr >= 0.5 && i / sr < 1.0 ? 0.3 * Math.sin(i * 0.2) : 0.0005 * Math.sin(i * 0.37)));
    const env = rmsEnvelope(pcm, sr);
    const [w] = refineWordBounds([{ text: "hi", start: 0.5, end: 2.0, confidence: 1 }], env, levelStats(pcm, env).silenceThresholdDb);
    expect(w.start).toBeCloseTo(0.5, 1);
    expect(w.end).toBeGreaterThan(0.99);
    expect(w.end).toBeLessThan(1.1);
  });

  it("aligns words to the audio around their DTW anchors", () => {
    const sr = 16000;
    // Speech 0.2-1.0 s and 2.0-2.6 s; Whisper's windows are late and run through the pause.
    const pcm = new Float32Array(sr * 3).map((_, i) => ((i / sr >= 0.2 && i / sr < 1.0) || (i / sr >= 2.0 && i / sr < 2.6) ? 0.3 * Math.sin(i * 0.2) : 0.0005 * Math.sin(i * 0.37)));
    const env = rmsEnvelope(pcm, sr);
    const out = alignWords(
      [
        { text: "hello", start: 0.1, end: 0.6, confidence: 1, anchor: 0.55 },
        { text: "there.", start: 0.6, end: 2.3, confidence: 1, anchor: 0.95 },
        { text: "Next", start: 2.3, end: 2.9, confidence: 1, anchor: 2.5 },
      ],
      env,
      levelStats(pcm, env).silenceThresholdDb,
    );
    expect(out[1].end).toBeGreaterThan(0.99);
    expect(out[1].end).toBeLessThan(1.1);
    expect(out[2].start).toBeGreaterThan(1.9);
    expect(out[2].start).toBeLessThan(2.05);
    expect(out[2].end).toBeGreaterThan(2.59);
    expect(out[2].end).toBeLessThan(2.7);
  });

  it("chunks long audio at quiet points", () => {
    const sr = 1000;
    const pcm = new Float32Array(sr * 200).map((_, i) => (Math.abs(i / sr - 61.2) < 0.3 || Math.abs(i / sr - 119.5) < 0.3 ? 0 : Math.sin(i)));
    const b = chunkBoundaries(pcm, sr);
    expect(b[0]).toBe(0);
    expect(b.at(-1)).toBe(200);
    expect(b[1]).toBeCloseTo(61.2, 0);
    expect(b[2]).toBeCloseTo(119.5, 0);
    expect(chunkBoundaries(new Float32Array(sr * 80), sr)).toEqual([0, 80]);
  });
});

describe.runIf(haveWhisper && canSpeak)("transcription with whisper.cpp", () => {
  it("transcribes speech with fillers, stable ids and real pauses", { timeout: 120_000 }, async () => {
    const job = host.transcripts.start([mediaId]);
    const done = await host.jobs.wait(job.id, 110_000);
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    const t = host.transcripts.get(mediaId)!;
    expect(t.words[0].id).toBe(1);
    expect(t.words.map((w) => w.id)).toEqual(t.words.map((_, i) => i + 1));
    const text = t.words.map((w) => normalizeWord(w.text)).join(" ");
    expect(text).toContain("here are three tips for better videos");
    expect(text).toContain("second cut every single silence");
    expect(t.words.filter((w) => w.isFiller).map((w) => normalizeWord(w.text))).toEqual(["um", "uh"]);
    // The 1.2 s pause after "videos." is now visible between the words.
    const iVideos = t.words.findIndex((w) => normalizeWord(w.text) === "videos");
    expect(t.words[iVideos + 1].startSourceSeconds - t.words[iVideos].endSourceSeconds).toBeGreaterThan(0.8);
    // Transcribing again is skipped unless forced; new transcriptions never reuse ids.
    const again = await host.jobs.wait(host.transcripts.start([mediaId]).id, 5000);
    expect((again.result as { skipped: string[] }).skipped).toEqual([mediaId]);
  });

  it("cleans up the edit and the audio confirms it", { timeout: 60_000 }, async () => {
    const before = mainTrack(host.project).elementIds.map((id) => host.project.elements[id].duration).reduce((a, b) => a + b);
    const opts = { cutPaddingSeconds: 0.08, minSilenceSeconds: 0.35, defaultCaptionStyle: "bold" };
    host.mutate("clean", "t", (c) => applyTranscriptOps(c, [{ op: "remove_retakes" }, { op: "remove_fillers" }, { op: "remove_silences" }, { op: "captions", maxWords: 3 }], host.transcripts.all(), opts), { skipFinalize: true });
    expect(plain()).toBe("here are three tips for better videos first keep your hook short second cut every single silence third add captions");
    const after = mainTrack(host.project).elementIds.map((id) => host.project.elements[id].duration).reduce((a, b) => a + b);
    expect(before - after).toBeGreaterThan(5);
    // Measure the rendered mix: no silence of 0.4 s or more is left.
    const mix = await renderAudioMix(host.project);
    const mono = toMono(mix.samples);
    const env = rmsEnvelope(mono, mix.sampleRate);
    const pauses = findPauses(env, levelStats(mono, env).silenceThresholdDb, 0.4, mix.durationSeconds);
    const near = (p: { start: number; end: number }) => words().filter((w) => w.end >= p.start - 0.6 && w.start <= p.end + 0.6).map((w) => `${w.text}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(" ");
    expect(pauses.map((p) => `${p.start.toFixed(2)}-${p.end.toFixed(2)}: ${near(p)}`)).toEqual([]);
    const captions = Object.values(host.project.elements).filter((e) => e.type === "caption");
    expect(captions.length).toBeGreaterThanOrEqual(8);
  });
});
