import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EditError, applyTranscriptOps, cleanTime, isFillerWord, mainTrack, removeMainRanges, type MediaTranscript, type OpResult, type TranscriptIndex, type TranscriptOp, type TranscriptWord } from "@openedits/core";
import { parseStyleGuide, type AutoEditPlan } from "./style.js";
import { findRetakesWithAi } from "../ai/features.js";
import { timelineWords } from "@openedits/core";
import type { EngineHost } from "../host.js";
import type { JobContext, JobInfo } from "../jobs.js";
import { decodePcm, runFfmpeg } from "../ffmpeg.js";
import { findPauses, levelStats, quietPoint, rmsEnvelope, type Envelope } from "../audio/dsp.js";

const execFileAsync = promisify(execFile);

/** Encourages Whisper to keep disfluencies ("um", "uh") instead of cleaning them up. */
const VERBATIM_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking.";
const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 60;

export const whisperPath = () => process.env.OPENEDITS_WHISPER ?? "whisper-cli";

const WHISPER_MISSING =
  "Transcription needs whisper.cpp (the whisper-cli program), which is not installed. macOS: `brew install whisper-cpp`. Windows and Linux: download it from github.com/ggml-org/whisper.cpp/releases and add it to PATH, or set OPENEDITS_WHISPER to its full path.";

let whisperFound: { path: string; ok: boolean } | undefined;

/** Whether the whisper.cpp CLI can be started (checked once per path). */
export async function whisperAvailable(): Promise<boolean> {
  const bin = whisperPath();
  if (whisperFound?.path === bin) return whisperFound.ok;
  let ok = true;
  try {
    await execFileAsync(bin, ["--help"], { windowsHide: true, timeout: 15_000 });
  } catch (e) {
    ok = (e as NodeJS.ErrnoException).code !== "ENOENT"; // a non-zero exit still means it is there
  }
  whisperFound = { path: bin, ok };
  return ok;
}

export async function transcriptionAvailable(modelPath: string): Promise<boolean> {
  return fs.existsSync(modelPath) && (await whisperAvailable());
}

export interface RawWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  /** DTW alignment time (seconds) of the word's last spoken token, near the end of the word. */
  anchor?: number;
}

interface WhisperSegment {
  text: string;
  offsets: { from: number; to: number };
  tokens?: { text: string; p: number; t_dtw?: number }[];
}

/** whisper.cpp DTW preset for a ggml model file, e.g. ggml-large-v3-turbo-q5_0.bin -> large.v3.turbo. */
export function dtwPreset(modelFile: string): string | undefined {
  const name = path.basename(modelFile).replace(/^ggml-/, "").replace(/\.bin$/, "").replace(/-q\d.*$/, "");
  const preset = name.replace(/-/g, ".");
  const known = ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large.v1", "large.v2", "large.v3", "large.v3.turbo"];
  return known.includes(preset) ? preset : undefined;
}

/** Parse whisper-cli `-ojf -ml 1 -sow` output: one segment per word, offsets in ms. */
export function parseWhisperJson(json: { transcription?: WhisperSegment[]; result?: { language?: string } }): { words: RawWord[]; language?: string } {
  const words: RawWord[] = [];
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim();
    if (!text || /^[[(].*[\])]$/.test(text)) continue; // [BLANK_AUDIO], (music)
    const spoken = (seg.tokens ?? []).filter((t) => !t.text.startsWith("[_") && t.text.trim());
    const probs = spoken.map((t) => t.p);
    const timed = spoken.filter((t) => /[\p{L}\p{N}]/u.test(t.text) && (t.t_dtw ?? -1) >= 0);
    words.push({
      text,
      start: seg.offsets.from / 1000,
      end: seg.offsets.to / 1000,
      confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0.5,
      ...(timed.length ? { anchor: timed[timed.length - 1].t_dtw! / 100 } : {}),
    });
  }
  return { words, ...(json.result?.language ? { language: json.result.language } : {}) };
}

/**
 * Whisper stretches word ends across the silence that follows. Tighten each word to where the
 * audio is actually above the silence threshold, so pauses become visible between words.
 */
export function refineWordBounds(words: RawWord[], env: Envelope, thresholdDb: number): RawWord[] {
  const hop = env.hopSeconds;
  const quietRun = Math.round(0.15 / hop);
  return words.map((w, i) => {
    const f0 = Math.max(0, Math.floor(w.start / hop));
    // Skip the last frames of Whisper's window: they often hold the onset of the next word.
    const f1 = Math.min(env.db.length - 1, Math.floor(w.end / hop) - 2);
    let first = -1;
    for (let f = f0; f <= f1; f++) {
      if (env.db[f] > thresholdDb) {
        first = f;
        break;
      }
    }
    if (first < 0) return w; // nothing audible: keep Whisper's timing
    // The word ends where 150 ms of silence begins (or at the last audible frame in the window).
    let last = first;
    let silent = 0;
    for (let f = first; f <= f1; f++) {
      if (env.db[f] > thresholdDb) {
        last = f;
        silent = 0;
      } else if (++silent >= quietRun) break;
    }
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    const start = Math.max(Math.min(prevEnd, w.start), w.start, first * hop - 0.02);
    const end = Math.min(w.end, (last + 1) * hop + 0.04);
    return end - start >= 0.05 ? { ...w, start, end } : w;
  });
}

interface Run {
  start: number;
  end: number;
}

/** Runs of at least `minSeconds` below the threshold. */
export function silentRuns(env: Envelope, thresholdDb: number, minSeconds = 0.15): Run[] {
  const out: Run[] = [];
  const hop = env.hopSeconds;
  let from = -1;
  for (let f = 0; f <= env.db.length; f++) {
    const quiet = f < env.db.length && env.db[f] <= thresholdDb;
    if (quiet && from < 0) from = f;
    if (!quiet && from >= 0) {
      if ((f - from) * hop >= minSeconds) out.push({ start: from * hop, end: f * hop });
      from = -1;
    }
  }
  return out;
}

/**
 * Word timing from DTW anchors plus the audio: a word ends where a silence starts near its anchor,
 * and starts where the silence before it ends. Words without an anchor fall back to `refineWordBounds`.
 */
export function alignWords(words: RawWord[], env: Envelope, thresholdDb: number): RawWord[] {
  if (!words.some((w) => w.anchor !== undefined)) return refineWordBounds(words, env, thresholdDb);
  const fallback = refineWordBounds(words, env, thresholdDb);
  const runs = silentRuns(env, thresholdDb);
  const total = env.db.length * env.hopSeconds;
  const out: RawWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prevEnd = out.length ? out[out.length - 1].end : 0;
    if (w.anchor === undefined) {
      const f = fallback[i];
      out.push({ ...f, start: Math.max(prevEnd, f.start), end: Math.max(Math.max(prevEnd, f.start) + 0.05, f.end) });
      continue;
    }
    let a = Math.max(prevEnd, w.anchor);
    const inside = runs.find((r) => r.start <= a && a < r.end);
    if (inside && inside.start > prevEnd) a = inside.start; // the anchor landed in the pause after the word
    const nextAnchor = words.slice(i + 1).find((x) => x.anchor !== undefined)?.anchor ?? total;
    const after = runs.find((r) => r.start >= a - 0.08 && r.start < Math.max(nextAnchor, a + 0.1));
    let end = after ? Math.max(a, after.start) + 0.03 : Math.min(a + 0.04, nextAnchor);
    const before = runs.filter((r) => r.end > prevEnd && r.end <= a).pop();
    const start = before ? Math.max(prevEnd, before.end - 0.02) : prevEnd;
    end = Math.min(total, Math.max(end, start + 0.05));
    out.push({ ...w, start, end });
  }
  return out;
}

/** Split points for long audio, placed at the quietest moment near every `chunk` seconds. */
export function chunkBoundaries(pcm: Float32Array, sampleRate: number, chunk = CHUNK_SECONDS): number[] {
  const duration = pcm.length / sampleRate;
  if (duration <= chunk * 1.5) return [0, duration];
  const out = [0];
  for (let t = chunk; t < duration - chunk / 2; t += chunk) out.push(quietPoint(pcm, sampleRate, t, 3, 0.05).time);
  out.push(duration);
  return out;
}

export class TranscriptService {
  constructor(private readonly host: EngineHost) {}

  all(): TranscriptIndex {
    return this.host.store.loadTranscripts();
  }

  get(mediaId: string): MediaTranscript | undefined {
    return this.all()[mediaId];
  }

  /** Main-track media (with audio) that has no transcript yet. */
  missingForTimeline(): string[] {
    const project = this.host.project;
    const have = this.all();
    const ids = new Set<string>();
    for (const id of mainTrack(project).elementIds) {
      const el = project.elements[id];
      if ((el?.type === "video" || el?.type === "audio") && project.media[el.mediaId]?.hasAudio && !have[el.mediaId]) ids.add(el.mediaId);
    }
    return [...ids];
  }

  private async runWhisper(wav: string, outBase: string, fromSeconds: number, toSeconds: number, language: string, signal: AbortSignal) {
    const model = this.host.settings.whisperModelPath;
    const args = ["-m", model, "-f", wav, "-l", language, "-ojf", "-ml", "1", "-sow", "-np", "--prompt", VERBATIM_PROMPT, "-of", outBase, "-ot", String(Math.round(fromSeconds * 1000)), "-d", String(Math.round((toSeconds - fromSeconds) * 1000))];
    // DTW token alignment (needs flash attention off) gives word times that line up with the audio.
    const dtw = dtwPreset(model);
    if (dtw) args.push("-nfa", "--dtw", dtw);
    try {
      await execFileAsync(whisperPath(), args, { signal, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (signal.aborted) throw new EditError("INTERNAL", "Cancelled");
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new EditError("NOT_IMPLEMENTED", WHISPER_MISSING);
      throw new EditError("INTERNAL", `whisper-cli failed: ${(e as Error).message.split("\n").slice(0, 2).join(" ")}`);
    }
    const json = JSON.parse(fs.readFileSync(`${outBase}.json`, "utf8"));
    fs.rmSync(`${outBase}.json`, { force: true });
    return parseWhisperJson(json);
  }

  /** Transcribe one media file (parallel chunks for long audio) and store it with fresh word ids. */
  async transcribe(mediaId: string, job: JobContext, opts: { language?: string } = {}): Promise<MediaTranscript> {
    const host = this.host;
    const media = host.project.media[mediaId];
    if (!media) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${mediaId}"`);
    if (!media.hasAudio) throw new EditError("UNSUPPORTED_MEDIA", `${media.name} has no audio to transcribe`);
    const model = host.settings.whisperModelPath;
    if (!(await whisperAvailable())) throw new EditError("NOT_IMPLEMENTED", WHISPER_MISSING);
    if (!fs.existsSync(model)) {
      throw new EditError("FILE_NOT_FOUND", `Transcription needs a Whisper model and none was found at ${model}. Download ${path.basename(model)} (or another ggml model) from huggingface.co/ggerganov/whisper.cpp and put it there, or point whisperModelPath in settings.json at the model you have.`, { path: model });
    }
    const language = opts.language ?? host.settings.language ?? "auto";
    const dir = path.join(host.projectDirPath, "cache", "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    const wav = path.join(dir, `${mediaId}.wav`);

    job.progress(0.02, `Decoding audio of ${media.name}`);
    await runFfmpeg(["-y", "-v", "error", "-i", media.path, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", wav], { signal: job.signal });
    try {
      const pcm = await decodePcm(wav, { sampleRate: SAMPLE_RATE, channels: 1 });
      const bounds = chunkBoundaries(pcm, SAMPLE_RATE);
      const chunks = bounds.slice(0, -1).map((from, i) => ({ from, to: bounds[i + 1], i }));
      const results: { words: RawWord[]; language?: string }[] = new Array(chunks.length);
      let done = 0;
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, chunks.length) }, async () => {
          while (next < chunks.length) {
            const c = chunks[next++];
            const r = await this.runWhisper(wav, path.join(dir, `${mediaId}-${c.i}`), c.from, c.to, language, job.signal);
            // A word belongs to the chunk its start falls in (whisper may run past the chunk end).
            results[c.i] = { ...r, words: r.words.filter((w) => w.start >= c.from - 1e-3 && w.start < c.to) };
            job.progress(0.05 + 0.85 * (++done / chunks.length), `Transcribed ${done}/${chunks.length} chunk${chunks.length > 1 ? "s" : ""}`);
          }
        }),
      );
      const raw = results.flatMap((r) => r.words).sort((a, b) => a.start - b.start);
      const env = rmsEnvelope(pcm, SAMPLE_RATE);
      const refined = alignWords(raw, env, levelStats(pcm, env).silenceThresholdDb);
      const firstId = host.store.allocateWordIds(refined.length);
      const words: TranscriptWord[] = refined.map((w, i) => ({
        id: firstId + i,
        text: w.text,
        startSourceSeconds: Math.round(w.start * 1000) / 1000,
        endSourceSeconds: Math.round(w.end * 1000) / 1000,
        confidence: Math.round(w.confidence * 1000) / 1000,
        isFiller: isFillerWord(w.text),
      }));
      const transcript: MediaTranscript = {
        mediaId,
        language: results.find((r) => r.language)?.language ?? language,
        model: path.basename(model),
        createdAt: host.now(),
        durationSourceSeconds: pcm.length / SAMPLE_RATE,
        words,
      };
      host.store.saveTranscript(transcript);
      job.progress(1, `${words.length} words`);
      host.emit("transcript", { projectId: host.projectId, mediaId, words: words.length });
      return transcript;
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  /** Start transcribing several media files in one background job. */
  start(mediaIds: string[], opts: { language?: string; force?: boolean } = {}): JobInfo {
    const host = this.host;
    for (const id of mediaIds) if (!host.project.media[id]) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${id}"`);
    const todo = opts.force ? mediaIds : mediaIds.filter((id) => !this.get(id));
    return host.jobs.start(
      "transcribe",
      async (job) => {
        const out: { mediaId: string; words: number; language: string }[] = [];
        for (const [k, id] of todo.entries()) {
          const sub: JobContext = { signal: job.signal, progress: (f, m) => job.progress((k + f) / todo.length, m) };
          const t = await this.transcribe(id, sub, opts);
          out.push({ mediaId: id, words: t.words.length, language: t.language });
        }
        return { transcribed: out, skipped: mediaIds.filter((id) => !todo.includes(id)) };
      },
      { projectId: host.projectId },
    );
  }

  /** Make sure every listed media has a transcript, transcribing as needed. */
  async ensure(mediaIds: string[], timeoutMs: number): Promise<{ job?: JobInfo }> {
    const missing = mediaIds.filter((id) => !this.get(id));
    if (!missing.length) return {};
    const job = this.start(missing);
    const done = await this.host.jobs.wait(job.id, timeoutMs);
    if (done.status === "running") throw new EditError("INTERNAL", `Transcription is still running (job ${job.id}); call again when it finishes`, { jobId: job.id });
    if (done.status !== "done") throw new EditError("INTERNAL", `Transcription failed: ${done.error?.message ?? done.status}`, { jobId: job.id });
    return { job: done };
  }

  /**
   * Resolve model-assisted ops before the edit: remove_retakes uses Claude when it is enabled
   * (method auto/ai), otherwise the local heuristic. Returns the ops plus notes for the caller.
   */
  async prepareOps(ops: TranscriptOp[]): Promise<{ ops: TranscriptOp[]; notes: string[] }> {
    const notes: string[] = [];
    const out: TranscriptOp[] = [];
    for (const op of ops) {
      if (op.op !== "remove_retakes" || op.wordRanges || op.method === "heuristic") {
        out.push(op);
        continue;
      }
      const reason = this.host.ai.unavailableReason();
      if (reason) {
        if (op.method === "ai") throw new EditError("NOT_IMPLEMENTED", reason);
        notes.push(`remove_retakes used the local heuristic (${reason})`);
        out.push({ ...op, method: "heuristic" });
        continue;
      }
      const words = timelineWords(this.host.project, this.all()).words;
      const r = await findRetakesWithAi(this.host.ai, words);
      notes.push(`remove_retakes: ${r.ranges.length} retake${r.ranges.length === 1 ? "" : "s"} chosen by ${r.model}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`);
      out.push({ ...op, wordRanges: r.ranges });
    }
    return { ops: out, notes };
  }

  /**
   * Silence removal from the audio itself, for when there is no transcript and whisper.cpp is not
   * installed: pauses in each main-track clip's sound are cut (keeping padding next to speech).
   */
  async removeSilencesFromAudio(op: Extract<TranscriptOp, { op: "remove_silences" }>, source: string, opts: { expectedVersion?: number } = {}) {
    const host = this.host;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== host.session.version) {
      throw new EditError("VERSION_CONFLICT", `Project changed (version ${host.session.version}, expected ${opts.expectedVersion}); re-read and retry`, { currentVersion: host.session.version });
    }
    const project = host.project;
    const min = op.minSilenceSeconds ?? host.settings.minSilenceSeconds;
    const pad = op.paddingSeconds ?? host.settings.cutPaddingSeconds;
    const ranges: { start: number; end: number }[] = [];
    const skipped: string[] = [];
    for (const id of mainTrack(project).elementIds) {
      const el = project.elements[id];
      if (el?.type !== "video" && el?.type !== "audio") continue;
      if (!project.media[el.mediaId]?.hasAudio || (el.type === "video" && el.audioDetached)) continue;
      if (el.speed.mode !== "constant") {
        skipped.push(el.id);
        continue;
      }
      const loaded = await host.audio.load({ elementId: id }, 16000);
      const env = rmsEnvelope(loaded.pcm, loaded.sampleRate);
      const stats = levelStats(loaded.pcm, env);
      const clipEnd = el.start + el.duration;
      for (const p of findPauses(env, stats.silenceThresholdDb, min, loaded.durationSeconds)) {
        const a = loaded.toOutput(p.start);
        const b = loaded.toOutput(p.end);
        const s = Math.max(el.start, Math.min(a, b));
        const e = Math.min(clipEnd, Math.max(a, b));
        // Keep a little air next to speech, but cut silence at the clip's own edges completely.
        const start = s <= el.start + 0.02 ? el.start : s + pad;
        const end = e >= clipEnd - 0.02 ? clipEnd : e - pad;
        if (end - start >= 1 / project.canvas.fps) ranges.push({ start, end });
      }
    }
    const notes = ["Silences were found from the audio (no transcript; install whisper.cpp for word-accurate cuts, fillers and retakes)"];
    if (skipped.length) notes.push(`Clips with speed ramps were left as they are: ${skipped.join(", ")}`);
    if (!ranges.length) {
      return { result: [{ op: "remove_silences", removedSeconds: 0, pauses: 0, ranges: [] }], version: host.session.version, label: "Remove silences", noop: true, changed: { elementIds: [], trackIds: [] }, created: [], removed: [], warnings: [], revisionBefore: undefined, notes: [...notes, "No silences long enough to cut were found"] };
    }
    const revision = host.saveRevision("Before remove silences", source);
    const res = host.mutate("Remove silences", source, (ctx) => {
      const removedSeconds = removeMainRanges(ctx, ranges, "inward");
      return [{ op: "remove_silences", removedSeconds, pauses: ranges.length, ranges: ranges.map((r) => ({ start: cleanTime(r.start), end: cleanTime(r.end) })) }];
    });
    return { ...res, revisionBefore: revision.number, notes };
  }

  /** Run word-id ops as one undo step, saving a numbered revision first (so a whole pass can be reverted). */
  async edit(rawOps: TranscriptOp[], source: string, opts: { expectedVersion?: number; label?: string } = {}) {
    const host = this.host;
    const missing = this.missingForTimeline();
    if (missing.length) {
      // Silence removal works from the audio alone; everything else needs words, so transcribe first.
      const onlySilences = rawOps.every((o) => o.op === "remove_silences");
      if (onlySilences && rawOps.length && !(await whisperAvailable())) return this.removeSilencesFromAudio(rawOps[0] as Extract<TranscriptOp, { op: "remove_silences" }>, source, opts);
      await this.ensure(missing, 30 * 60_000);
    }
    const { ops, notes } = await this.prepareOps(rawOps);
    const transcripts = this.all();
    if (!Object.keys(transcripts).length) throw new EditError("INVALID_ARGUMENT", "No transcripts yet: run transcribeClip (or auto_edit) first");
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== host.session.version) {
      throw new EditError("VERSION_CONFLICT", `Project changed (version ${host.session.version}, expected ${opts.expectedVersion}); re-read and retry`, { currentVersion: host.session.version });
    }
    const revision = host.saveRevision(`Before ${opts.label ?? `edit: ${ops.map((o) => o.op).join(", ")}`}`, source);
    const settings = host.settings;
    const res = host.mutate(
      opts.label ?? `Edit: ${ops.map((o) => o.op).join(", ")}`,
      source,
      (ctx) => applyTranscriptOps(ctx, ops, transcripts, { cutPaddingSeconds: settings.cutPaddingSeconds, minSilenceSeconds: settings.minSilenceSeconds, defaultCaptionStyle: settings.defaultCaptionStyle }),
      { skipFinalize: true },
    );
    return { ...res, revisionBefore: revision.number, notes };
  }

  /** The automatic first pass described by STYLE.md (plus explicit overrides). */
  plan(overrides: Partial<AutoEditPlan> = {}): { plan: AutoEditPlan; ops: TranscriptOp[] } {
    const host = this.host;
    const plan = { ...parseStyleGuide(host.getStyleGuide(), { captionStyle: host.settings.defaultCaptionStyle, minSilenceSeconds: host.settings.minSilenceSeconds }), ...overrides };
    const ops: TranscriptOp[] = [];
    if (plan.removeRetakes) ops.push({ op: "remove_retakes" });
    if (plan.removeFillers) ops.push({ op: "remove_fillers" });
    if (plan.removeSilences) ops.push({ op: "remove_silences", ...(plan.minSilenceSeconds ? { minSilenceSeconds: plan.minSilenceSeconds } : {}) });
    if (plan.zoomScale) ops.push({ op: "auto_zoom", scale: plan.zoomScale });
    if (plan.captions) ops.push({ op: "captions", style: plan.captions.style, ...(plan.captions.maxWords ? { maxWords: plan.captions.maxWords } : {}) });
    return { plan, ops };
  }

  /** Transcribe what is missing, then apply the STYLE.md first pass as one undo step. */
  startAutoEdit(source: string, overrides: Partial<AutoEditPlan> = {}, opts: { render?: "preview" | "final" } = {}): JobInfo {
    const host = this.host;
    const { plan, ops } = this.plan(overrides);
    if (!ops.length) throw new EditError("INVALID_ARGUMENT", "STYLE.md and the overrides turn every automatic step off");
    if (!mainTrack(host.project).elementIds.length) throw new EditError("INVALID_RANGE", "The main track is empty");
    return host.jobs.start(
      "auto_edit",
      async (job) => {
        const missing = this.missingForTimeline();
        for (const [k, id] of missing.entries()) {
          await this.transcribe(id, { signal: job.signal, progress: (f, m) => job.progress(0.7 * ((k + f) / missing.length), m) });
        }
        job.progress(0.75, "Editing");
        const res = await this.edit(ops, source, { label: "auto_edit" });
        let render: unknown;
        if (opts.render) {
          job.progress(0.8, `Rendering ${opts.render}`);
          const r = host.render.startRender({ mode: opts.render === "final" ? "export" : "preview" });
          const done = await host.jobs.wait(r.id, 30 * 60_000);
          render = done.status === "done" ? done.result : { status: done.status, error: done.error };
        }
        return { plan, ops, results: res.result as OpResult[], version: res.version, revisionBefore: res.revisionBefore, transcribed: missing, ...(render ? { render } : {}), warnings: res.warnings, notes: res.notes };
      },
      { projectId: host.projectId },
    );
  }
}
