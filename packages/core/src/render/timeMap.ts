import type { Project, SourcedElement } from "../schema.js";
import { rateAt, sourcePositionAtTime } from "../speed.js";

function edgeRate(el: SourcedElement, edge: 0 | 1): number {
  return el.speed.mode === "constant" ? el.speed.rate : rateAt(el.speed.points, edge);
}

/** Normalized playback position (0..1 along the direction of play) at a timeline time. */
export function playbackPosition(el: SourcedElement, timelineSeconds: number): number {
  return sourcePositionAtTime(timelineSeconds - el.start, el.duration, el.speed);
}

/**
 * Source timestamp shown/heard at a timeline time. With `extrapolate`, times outside the
 * element continue into the media handles (used by transitions).
 */
export function sourceTimeAt(project: Project, el: SourcedElement, timelineSeconds: number, opts: { extrapolate?: boolean } = {}): number {
  const span = el.sourceDurationSourceSeconds;
  const local = timelineSeconds - el.start;
  let offset: number; // source seconds from the start of play
  if (opts.extrapolate && local < 0) offset = local * edgeRate(el, 0);
  else if (opts.extrapolate && local > el.duration) offset = span + (local - el.duration) * edgeRate(el, 1);
  else offset = playbackPosition(el, timelineSeconds) * span;
  const t = el.reversed ? el.sourceInSourceSeconds + span - offset : el.sourceInSourceSeconds + offset;
  const total = project.media[el.mediaId]?.durationSourceSeconds ?? Infinity;
  return Math.min(Math.max(0, t), Math.max(0, total));
}

/** Timeline time at which a source timestamp plays, or null when it is outside the element (constant speed only). */
export function timelineTimeOfSource(el: SourcedElement, sourceSeconds: number): number | null {
  if (el.speed.mode !== "constant") return null;
  const rel = sourceSeconds - el.sourceInSourceSeconds;
  if (rel < -1e-6 || rel > el.sourceDurationSourceSeconds + 1e-6) return null;
  const offset = el.reversed ? el.sourceDurationSourceSeconds - rel : rel;
  return el.start + offset / el.speed.rate;
}

export interface SpeedSegment {
  /** Normalized playback positions. */
  p0: number;
  p1: number;
  rate: number;
}

/** Approximate a speed definition with constant-rate segments (for audio time-stretching). */
export function speedSegments(el: SourcedElement, maxSegments = 48): SpeedSegment[] {
  if (el.speed.mode === "constant") return [{ p0: 0, p1: 1, rate: el.speed.rate }];
  const n = Math.max(2, Math.min(maxSegments, Math.ceil(el.duration / 0.2)));
  const out: SpeedSegment[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = sourcePositionAtTime((el.duration * i) / n, el.duration, el.speed);
    const p1 = sourcePositionAtTime((el.duration * (i + 1)) / n, el.duration, el.speed);
    const srcDur = (p1 - p0) * el.sourceDurationSourceSeconds;
    if (srcDur <= 1e-6) continue;
    out.push({ p0, p1, rate: srcDur / (el.duration / n) });
  }
  return out.length ? out : [{ p0: 0, p1: 1, rate: 1 }];
}
