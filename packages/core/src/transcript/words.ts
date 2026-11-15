import type { Project, SourcedElement } from "../schema.js";
import { mainTrack } from "../timeline/query.js";
import { timelineTimeOfSource } from "../render/timeMap.js";
import { cleanTime } from "../units.js";

/** One transcribed word. Ids are stable for the life of the project: edits refer to them. */
export interface TranscriptWord {
  id: number;
  text: string;
  startSourceSeconds: number;
  endSourceSeconds: number;
  /** 0..1 */
  confidence: number;
  isFiller: boolean;
}

export interface MediaTranscript {
  mediaId: string;
  language: string;
  model: string;
  createdAt: number;
  durationSourceSeconds: number;
  words: TranscriptWord[];
}

export type TranscriptIndex = Record<string, MediaTranscript>;

/** A transcript word as it currently plays on the main track. */
export interface TimelineWord {
  id: number;
  text: string;
  start: number;
  end: number;
  elementId: string;
  mediaId: string;
  isFiller: boolean;
  confidence: number;
}

export const FILLER_WORDS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mhm", "eh"]);

export function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, "");
}

export function isFillerWord(text: string): boolean {
  return FILLER_WORDS.has(normalizeWord(text));
}

export function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]*$/.test(text.trim());
}

function sourcedMainElements(project: Project): SourcedElement[] {
  return mainTrack(project)
    .elementIds.map((id) => project.elements[id])
    .filter((el): el is SourcedElement => el?.type === "video" || el?.type === "audio");
}

/**
 * Words that currently play on the main track, in timeline order. A word is included when its
 * midpoint lies in a clip's source window. Clips with speed curves are skipped (reported in `skipped`).
 */
export function timelineWords(project: Project, transcripts: TranscriptIndex): { words: TimelineWord[]; skipped: string[] } {
  const words: TimelineWord[] = [];
  const skipped: string[] = [];
  for (const el of sourcedMainElements(project)) {
    const t = transcripts[el.mediaId];
    if (!t) continue;
    if (el.speed.mode !== "constant") {
      skipped.push(el.id);
      continue;
    }
    const inPoint = el.sourceInSourceSeconds;
    const outPoint = inPoint + el.sourceDurationSourceSeconds;
    for (const w of t.words) {
      const mid = (w.startSourceSeconds + w.endSourceSeconds) / 2;
      if (mid < inPoint || mid >= outPoint) continue;
      const a = timelineTimeOfSource(el, Math.max(inPoint, w.startSourceSeconds));
      const b = timelineTimeOfSource(el, Math.min(outPoint, w.endSourceSeconds));
      if (a === null || b === null) continue;
      words.push({ id: w.id, text: w.text, start: cleanTime(Math.min(a, b)), end: cleanTime(Math.max(a, b)), elementId: el.id, mediaId: el.mediaId, isFiller: w.isFiller, confidence: w.confidence });
    }
  }
  words.sort((x, y) => x.start - y.start || x.id - y.id);
  return { words, skipped };
}

/** Timeline spans of main-track clips that have a transcript (cuts derived from words stay inside these). */
export function transcribedSpans(project: Project, transcripts: TranscriptIndex): { start: number; end: number; elementId: string }[] {
  return sourcedMainElements(project)
    .filter((el) => transcripts[el.mediaId] && el.speed.mode === "constant")
    .map((el) => ({ start: el.start, end: el.start + el.duration, elementId: el.id }));
}

/** Plain-text transcript with #ids, pauses and filler markers (what agents read). */
export function formatTranscript(words: TimelineWord[], opts: { pauseSeconds?: number } = {}): string {
  const pause = opts.pauseSeconds ?? 0.35;
  const out: string[] = [];
  let line: string[] = [];
  const flush = () => {
    if (line.length) out.push(line.join(" "));
    line = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (prev) {
      const gap = w.start - prev.end;
      if (gap >= pause) {
        flush();
        out.push(`  [pause ${gap.toFixed(2)}s]`);
      } else if (prev.elementId !== w.elementId) {
        flush();
        out.push("  [cut]");
      }
    }
    if (!line.length) line.push(`${w.start.toFixed(2)}s`);
    line.push(`#${w.id} ${w.text}${w.isFiller ? "(filler)" : ""}`);
    if (endsSentence(w.text)) flush();
  });
  flush();
  return out.join("\n");
}
