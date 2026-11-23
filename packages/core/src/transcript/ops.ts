import type { CaptionElement, Element, Project, TextStyle } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import type { EditContext } from "../ops/context.js";
import { finalize, snapshotMain } from "../timeline/finalize.js";
import { mainTrack } from "../timeline/query.js";
import { splitElement, deleteElements } from "../ops/edit.js";
import { reorderMain } from "../ops/arrange.js";
import { addCaptions, addText } from "../ops/text.js";
import { setBrief } from "../ops/project.js";
import { findCatalogItem, getCatalogItem } from "../catalog/index.js";
import type { CaptionStyleData } from "../catalog/text.js";
import { endsSentence, isFillerWord, normalizeWord, timelineWords, transcribedSpans, type TimelineWord, type TranscriptIndex } from "./words.js";

export type TranscriptOp =
  | { op: "remove_silences"; minSilenceSeconds?: number; paddingSeconds?: number }
  | { op: "remove_fillers"; paddingSeconds?: number }
  | { op: "remove_retakes"; paddingSeconds?: number; method?: "auto" | "heuristic" | "ai"; wordRanges?: [number, number][] }
  | { op: "cut"; from: number; to: number; paddingSeconds?: number }
  | { op: "move_to_start"; from: number; to: number }
  | { op: "auto_zoom"; scale?: number }
  | { op: "captions"; style?: string; maxWords?: number; y?: number }
  | { op: "title"; text: string; durationSeconds?: number; presetId?: string }
  | { op: "brief"; text: string };

export interface TranscriptEditOptions {
  /** Silence kept on each side of a cut (seconds). */
  cutPaddingSeconds: number;
  minSilenceSeconds: number;
  defaultCaptionStyle: string;
}

export interface OpResult {
  op: string;
  /** Timeline seconds removed by this op. */
  removedSeconds?: number;
  removedWordIds?: number[];
  ranges?: { start: number; end: number }[];
  detail?: string;
  [key: string]: unknown;
}

interface Range {
  start: number;
  end: number;
}

type Span = { start: number; end: number; elementId: string };

function mergeRanges(ranges: Range[], minLength = 1 / 240): Range[] {
  const sorted = ranges.filter((r) => r.end - r.start > minLength).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Keep only the parts of a range that lie on clips with transcripts (never cut B-roll by accident). */
function clipToSpans(r: Range, spans: Span[]): Range[] {
  const out: Range[] = [];
  for (const s of spans) {
    const start = Math.max(r.start, s.start);
    const end = Math.min(r.end, s.end);
    if (end - start > EPS) out.push({ start, end });
  }
  return out;
}

/**
 * Remove timeline ranges from the main track (split at the edges, delete what is inside).
 * The magnetic track closes the gaps when the op finalizes.
 */
export function removeMainRanges(ctx: EditContext, ranges: Range[], snap: "inward" | "outward" = "outward"): number {
  const project = ctx.draft;
  const fps = project.canvas.fps;
  // Inward keeps every kept word intact (silence removal); outward removes cut words completely.
  const lo = (t: number) => (snap === "inward" ? Math.ceil(t * fps - 1e-6) : Math.floor(t * fps + 1e-6)) / fps;
  const hi = (t: number) => (snap === "inward" ? Math.floor(t * fps + 1e-6) : Math.ceil(t * fps - 1e-6)) / fps;
  const merged = mergeRanges(ranges.map((r) => ({ start: cleanTime(lo(r.start)), end: cleanTime(hi(r.end)) })));
  let removed = 0;
  for (const r of merged.reverse()) {
    for (const t of [r.end, r.start]) {
      const el = mainTrack(project)
        .elementIds.map((id) => project.elements[id])
        .find((e) => t > e.start + EPS && t < e.start + e.duration - EPS);
      if (el) splitElement(ctx, el, t);
    }
    const inside = mainTrack(project)
      .elementIds.map((id) => project.elements[id])
      .filter((e) => e.start >= r.start - 1e-4 && e.start + e.duration <= r.end + 1e-4);
    for (const e of inside) removed += e.duration;
    if (inside.length) deleteElements(ctx, inside.map((e) => e.id));
  }
  return cleanTime(removed);
}

function spanOf(spans: Span[], w: TimelineWord): Span | undefined {
  return spans.find((s) => s.elementId === w.elementId);
}

/**
 * The timeline range that removes words[i..j] plus most of the silence around them,
 * keeping `pad` seconds of room next to the neighbouring words.
 */
function wordRunRange(words: TimelineWord[], i: number, j: number, spans: Span[], pad: number): Range {
  const a = words[i];
  const b = words[j];
  const prev = words[i - 1];
  const next = words[j + 1];
  const spanA = spanOf(spans, a);
  const spanB = spanOf(spans, b);
  const start = prev ? Math.min(a.start, prev.end + Math.min(pad, (a.start - prev.end) / 2)) : spanA?.start ?? a.start;
  const end = next ? Math.max(b.end, next.start - Math.min(pad, (next.start - b.end) / 2)) : spanB?.end ?? b.end;
  return { start, end };
}

/** Tight bounds around words[i..j] with `pad` of room, never reaching into the neighbouring words. */
function wordRunSpan(words: TimelineWord[], i: number, j: number, spans: Span[], pad: number): Range {
  const a = words[i];
  const b = words[j];
  const prev = words[i - 1];
  const next = words[j + 1];
  const floor = prev && prev.elementId === a.elementId ? prev.end : spanOf(spans, a)?.start ?? 0;
  const ceil = next && next.elementId === b.elementId ? next.start : spanOf(spans, b)?.end ?? b.end;
  return { start: Math.max(floor, a.start - pad), end: Math.min(ceil, b.end + pad) };
}

/** Group a sorted list of word indices into contiguous runs. */
function runs(indices: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

const tokenize = (words: TimelineWord[]) =>
  words
    .filter((w) => !w.isFiller)
    .map((w) => normalizeWord(w.text))
    .filter(Boolean)
    .map((t) => (t.length > 3 ? t.replace(/(es|s)$/, "") : t));

interface Sentence {
  from: number;
  to: number;
  tokens: string[];
}

/** Split timeline words into sentences at punctuation or long pauses. */
export function sentences(words: TimelineWord[], pauseSeconds = 0.6): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    if (!next || endsSentence(words[i].text) || next.start - words[i].end >= pauseSeconds) {
      out.push({ from, to: i, tokens: tokenize(words.slice(from, i + 1)) });
      from = i + 1;
    }
  }
  return out;
}

/** True when `a` looks like an abandoned or repeated take of `b` (b is the keeper). */
export function isRetake(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  if (prefix === a.length && a.length < b.length) return true; // false start: "so the" -> "so the main thing"
  if (prefix >= 2 && prefix >= a.length * 0.5) return true; // restart after the opening words
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return a.length >= 3 && a[0] === b[0] && shared / a.length >= 0.75;
}

/** Word index runs to drop as retakes: every take but the last of a repeated sentence. */
export function findRetakes(words: TimelineWord[]): { from: number; to: number; keptFrom: number }[] {
  const ss = sentences(words);
  const out: { from: number; to: number; keptFrom: number }[] = [];
  for (let k = 0; k < ss.length; k++) {
    for (const j of [k + 1, k + 2]) {
      const b = ss[j];
      if (!b) continue;
      // Only look two sentences ahead when the one in between is a fragment.
      if (j === k + 2 && ss[k + 1].tokens.length > 2) continue;
      if (isRetake(ss[k].tokens, b.tokens)) {
        out.push({ from: ss[k].from, to: j === k + 2 ? ss[k + 1].to : ss[k].to, keptFrom: b.from });
        break;
      }
    }
  }
  return out;
}

function wordRunsById(words: TimelineWord[], from: number, to: number): [number, number][] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new EditError("INVALID_ARGUMENT", `Word range #${from}..#${to} is invalid (from must be <= to)`);
  const idx = words.map((w, i) => (w.id >= from && w.id <= to ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) throw new EditError("INVALID_ARGUMENT", `Words #${from}..#${to} are not on the timeline (already cut, or not transcribed). Call get_transcript for current ids.`);
  return runs(idx);
}

function generatedCaptions(ctx: EditContext): CaptionElement[] {
  return Object.values(ctx.draft.elements).filter((e): e is CaptionElement => e.type === "caption" && !!e.sourceMediaId);
}

/** Group words into caption segments: at most `maxWords`, breaking at sentence ends and pauses. */
export function captionSegments(words: TimelineWord[], maxWords: number): { start: number; end: number; words: TimelineWord[] }[] {
  const out: { start: number; end: number; words: TimelineWord[] }[] = [];
  let cur: TimelineWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (!next || cur.length >= maxWords || endsSentence(w.text) || next.start - w.end > 0.5 || next.elementId !== w.elementId && next.start - w.end > 0.05) flush();
  });
  flush();
  // Hold each caption until the next one starts when the gap is short.
  for (let i = 0; i < out.length - 1; i++) {
    const gap = out[i + 1].start - out[i].end;
    if (gap > 0 && gap < 0.35) out[i].end = out[i + 1].start;
  }
  for (const seg of out) if (seg.end - seg.start < 0.1) seg.end = seg.start + 0.1;
  return out;
}

function buildCaptions(ctx: EditContext, words: TimelineWord[], style: string, maxWords: number | undefined, y: number | undefined) {
  const item = getCatalogItem("captionStyles", style);
  const data = item.data as CaptionStyleData;
  for (const c of generatedCaptions(ctx)) {
    const t = ctx.draft.tracks.find((tr) => tr.id === c.trackId);
    if (t) t.elementIds = t.elementIds.filter((id) => id !== c.id);
    delete ctx.draft.elements[c.id];
    ctx.removed.push(c.id);
  }
  const segs = captionSegments(words, maxWords ?? data.maxWords);
  if (!segs.length) return 0;
  const created = addCaptions(
    ctx,
    segs.map((s) => ({ start: s.start, end: s.end, words: s.words.map((w) => ({ text: w.text, start: Math.max(s.start, w.start), end: Math.min(s.end, w.end), id: w.id })) })),
    { styleId: item.id, highlightColor: data.highlightColor, sourceMediaId: segs[0].words[0].mediaId },
  );
  if (y !== undefined) for (const c of created) c.transform.y = y;
  return created.length;
}

function transcriptSilences(words: TimelineWord[], spans: Span[], min: number, pad: number): Range[] {
  const ranges: Range[] = [];
  for (const span of spans) {
    const inSpan = words.filter((w) => w.elementId === span.elementId);
    if (!inSpan.length) {
      if (span.end - span.start >= min) ranges.push({ start: span.start, end: span.end });
      continue;
    }
    if (inSpan[0].start - span.start >= min) ranges.push({ start: span.start, end: inSpan[0].start - pad });
    for (let k = 0; k < inSpan.length - 1; k++) {
      const gap = inSpan[k + 1].start - inSpan[k].end;
      if (gap >= min) ranges.push({ start: inSpan[k].end + pad, end: inSpan[k + 1].start - pad });
    }
    const last = inSpan[inSpan.length - 1];
    if (span.end - last.end >= min) ranges.push({ start: last.end + pad, end: span.end });
  }
  return mergeRanges(ranges);
}

export function suggestTranscriptCuts(project: Project, transcripts: TranscriptIndex, opts: TranscriptEditOptions) {
  const { words } = timelineWords(project, transcripts);
  const spans = transcribedSpans(project, transcripts);
  const pad = opts.cutPaddingSeconds;
  const fillers = runs(words.flatMap((w, i) => w.isFiller || isFillerWord(w.text) ? [i] : []));
  const retakes = findRetakes(words).map((take): [number, number] => [take.from, take.to]);
  const wordCuts = (ranges: [number, number][], reason: string) => ranges.flatMap(([i, j]) =>
    clipToSpans(wordRunRange(words, i, j, spans, pad), spans).map((range) => ({
      ...range, reasons: [reason], text: words.slice(i, j + 1).map((word) => word.text).join(" "),
    })));
  return [
    ...transcriptSilences(words, spans, opts.minSilenceSeconds, pad).map((range) => ({ ...range, reasons: ["Silence"], text: "" })),
    ...wordCuts(fillers, "Filler"),
    ...wordCuts(retakes, "Retake"),
  ];
}

export function applyReviewedCuts(ctx: EditContext, ranges: Range[], transcripts: TranscriptIndex) {
  const previous = generatedCaptions(ctx);
  const corrections = new Map(previous.flatMap((caption) => caption.words.flatMap((word) =>
    typeof word.id === "number" ? [[word.id, word.text] as const] : [])));
  const snap = snapshotMain(ctx.draft);
  const removedSeconds = removeMainRanges(ctx, ranges, "inward");
  finalize(ctx, snap);
  if (removedSeconds > 0 && previous.length) {
    const caption = previous[0];
    const words = timelineWords(ctx.draft, transcripts).words.map((word) => ({
      ...word, text: corrections.get(word.id) ?? word.text,
    }));
    if (findCatalogItem("captionStyles", caption.styleId) && words.length) {
      const before = snapshotMain(ctx.draft);
      buildCaptions(ctx, words, caption.styleId, undefined, caption.transform.y);
      const existingIds = new Set(previous.map((item) => item.id));
      for (const result of generatedCaptions(ctx)) if (!existingIds.has(result.id)) {
        result.styleOverrides = caption.styleOverrides;
        result.highlightColor = caption.highlightColor;
      }
      finalize(ctx, before);
    }
  }
  return removedSeconds;
}

/**
 * Apply OpenCut-style transcript ops in order. Callers must run this in a transaction with
 * `skipFinalize: true`: each op lays out the timeline before the next one reads the words.
 */
export function applyTranscriptOps(ctx: EditContext, ops: TranscriptOp[], transcripts: TranscriptIndex, opts: TranscriptEditOptions): OpResult[] {
  if (!ops.length) throw new EditError("INVALID_ARGUMENT", "ops must not be empty");
  if (!Object.keys(transcripts).length) throw new EditError("INVALID_ARGUMENT", "No transcripts yet: run transcribeClip (or auto_edit) first");
  const results: OpResult[] = [];
  const hadCaptions = generatedCaptions(ctx)[0];
  const captionStyle = hadCaptions?.styleId;
  let removedAny = false;
  let captionsDone = false;

  for (const op of ops) {
    const snap = snapshotMain(ctx.draft);
    const { words } = timelineWords(ctx.draft, transcripts);
    const spans = transcribedSpans(ctx.draft, transcripts);
    const pad = "paddingSeconds" in op && op.paddingSeconds !== undefined ? op.paddingSeconds : opts.cutPaddingSeconds;
    let result: OpResult;
    const removeRuns = (rs: [number, number][], label: string): OpResult => {
      const ranges = mergeRanges(rs.flatMap(([i, j]) => clipToSpans(wordRunRange(words, i, j, spans, pad), spans)));
      const removedSeconds = removeMainRanges(ctx, ranges);
      if (removedSeconds > 0) removedAny = true;
      return { op: label, removedSeconds, removedWordIds: rs.flatMap(([i, j]) => words.slice(i, j + 1).map((w) => w.id)), ranges: ranges.map((r) => ({ start: cleanTime(r.start), end: cleanTime(r.end) })) };
    };
    switch (op.op) {
      case "remove_silences": {
        const min = op.minSilenceSeconds ?? opts.minSilenceSeconds;
        const merged = transcriptSilences(words, spans, min, pad);
        const removedSeconds = removeMainRanges(ctx, merged, "inward");
        if (removedSeconds > 0) removedAny = true;
        result = { op: op.op, removedSeconds, pauses: merged.length, ranges: merged.map((r) => ({ start: cleanTime(r.start), end: cleanTime(r.end) })) };
        break;
      }
      case "remove_fillers": {
        const idx = words.map((w, i) => (w.isFiller || isFillerWord(w.text) ? i : -1)).filter((i) => i >= 0);
        result = removeRuns(runs(idx), op.op);
        break;
      }
      case "remove_retakes": {
        if (op.wordRanges) {
          // Ranges chosen upstream (e.g. by a model) as word ids; ids that were already cut are skipped.
          const rs = op.wordRanges.flatMap(([from, to]) => {
            const idx = words.map((w, i) => (w.id >= from && w.id <= to ? i : -1)).filter((i) => i >= 0);
            return runs(idx);
          });
          result = removeRuns(rs, op.op);
          result.retakes = rs.map(([i, j]) => ({ removed: words.slice(i, j + 1).map((w) => w.text).join(" ") }));
          result.method = "ai";
          break;
        }
        const takes = findRetakes(words);
        result = removeRuns(takes.map((t) => [t.from, t.to] as [number, number]), op.op);
        result.retakes = takes.map((t) => ({ removed: words.slice(t.from, t.to + 1).map((w) => w.text).join(" "), keptStartsAt: `#${words[t.keptFrom].id}` }));
        result.method = "heuristic";
        break;
      }
      case "cut":
        result = removeRuns(wordRunsById(words, op.from, op.to), op.op);
        break;
      case "move_to_start": {
        if (!ctx.draft.rippleSettings.magnetEnabled) throw new EditError("INVALID_ARGUMENT", "move_to_start needs the magnetic main track (setRippleTiers magnetEnabled)");
        const rs = wordRunsById(words, op.from, op.to);
        if (rs.length !== 1) throw new EditError("INVALID_ARGUMENT", `Words #${op.from}..#${op.to} are not contiguous on the timeline`);
        const [i, j] = rs[0];
        const r = wordRunSpan(words, i, j, spans, opts.cutPaddingSeconds);
        const fps = ctx.draft.canvas.fps;
        const t0 = Math.floor(r.start * fps + 1e-6) / fps;
        const t1 = Math.ceil(r.end * fps - 1e-6) / fps;
        for (const t of [t1, t0]) {
          const el = mainTrack(ctx.draft).elementIds.map((id) => ctx.draft.elements[id]).find((e) => t > e.start + EPS && t < e.start + e.duration - EPS);
          if (el) splitElement(ctx, el, t);
        }
        const moving = mainTrack(ctx.draft).elementIds.map((id) => ctx.draft.elements[id]).filter((e) => e.start >= t0 - 1e-4 && e.start + e.duration <= t1 + 1e-4);
        moving.forEach((e, k) => reorderMain(ctx, e, k));
        result = { op: op.op, movedSeconds: cleanTime(t1 - t0), from: cleanTime(t0) };
        break;
      }
      case "auto_zoom": {
        const scale = op.scale ?? 1.12;
        const talking = mainTrack(ctx.draft)
          .elementIds.map((id) => ctx.draft.elements[id])
          .filter((e): e is Extract<Element, { type: "video" }> => e.type === "video" && !!transcripts[e.mediaId]);
        let zoomed = 0;
        talking.forEach((e, k) => {
          if (e.keyframes.scale?.length) return;
          e.transform.scale = k % 2 === 1 ? scale : 1;
          if (k % 2 === 1) zoomed++;
          ctx.touch(e.id);
        });
        result = { op: op.op, clips: talking.length, zoomedClips: zoomed, scale };
        break;
      }
      case "captions": {
        const count = buildCaptions(ctx, words, op.style ?? captionStyle ?? opts.defaultCaptionStyle, op.maxWords, op.y);
        captionsDone = true;
        result = { op: op.op, captions: count, style: op.style ?? captionStyle ?? opts.defaultCaptionStyle };
        break;
      }
      case "title": {
        const preset = op.presetId ?? "headline";
        const style = (getCatalogItem("textPresets", preset).data as { style: Partial<TextStyle> }).style;
        const el = addText(ctx, { text: op.text, start: 0, duration: op.durationSeconds ?? 2.5, style: { maxWidthNorm: 0.84, ...style }, presetId: preset, transform: { y: 0.16 } });
        result = { op: op.op, elementId: el.id };
        break;
      }
      case "brief":
        setBrief(ctx, op.text);
        result = { op: op.op };
        break;
      default:
        throw new EditError("INVALID_ARGUMENT", `Unknown op "${(op as { op: string }).op}"`);
    }
    finalize(ctx, snap);
    results.push(result);
  }

  // Keep generated captions in sync with the words after cuts.
  if (removedAny && hadCaptions && !captionsDone && findCatalogItem("captionStyles", captionStyle!)) {
    const snap = snapshotMain(ctx.draft);
    const count = buildCaptions(ctx, timelineWords(ctx.draft, transcripts).words, captionStyle!, undefined, hadCaptions.transform.y);
    finalize(ctx, snap);
    results.push({ op: "captions", captions: count, style: captionStyle, detail: "re-synced automatically after cuts" });
  }
  return results;
}
