import type { CaptionElement, Element, KeyframeProperty, Keyframes, SourcedElement } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, MIN_DURATION, cleanTime, snapProjectFrame, sourceFrameCeil } from "../units.js";
import { rateAt, sliceSpeed, sourcePositionAtTime, timelineDurationFor } from "../speed.js";
import { splitKeyframes, trimKeyframesHead, trimKeyframesTail } from "../keyframes.js";
import { assertUnlocked, elementEnd, isOnMain, mainTrack, requireElement, trackOf } from "../timeline/query.js";
import { detachFromTrack } from "../timeline/tracks.js";
import type { EditContext } from "./context.js";
import { cloneElement } from "./elements.js";
import { keyframeFallback } from "./visual.js";

function isSourced(el: Element): el is SourcedElement {
  return el.type === "video" || el.type === "audio";
}

function minDuration(ctx: EditContext) {
  return Math.max(MIN_DURATION, 1 / ctx.draft.canvas.fps);
}

function splitAllKeyframes(el: Element, offset: number): { left: Keyframes; right: Keyframes } {
  const left: Keyframes = {};
  const right: Keyframes = {};
  for (const [prop, kfs] of Object.entries(el.keyframes) as [KeyframeProperty, NonNullable<Keyframes[KeyframeProperty]>][]) {
    if (!kfs || kfs.length === 0) continue;
    const r = splitKeyframes(kfs, offset, keyframeFallback(el, prop));
    left[prop] = r.left;
    right[prop] = r.right;
  }
  return { left, right };
}

function partitionCaptionWords(el: CaptionElement, offset: number) {
  const left = el.words.filter((w) => (w.startOffsetSeconds + w.endOffsetSeconds) / 2 < offset);
  const right = el.words.filter((w) => (w.startOffsetSeconds + w.endOffsetSeconds) / 2 >= offset);
  return {
    left: left.map((w) => ({ ...w, endOffsetSeconds: Math.min(w.endOffsetSeconds, offset) })),
    right: right.map((w) => ({
      ...w,
      startOffsetSeconds: cleanTime(Math.max(0, w.startOffsetSeconds - offset)),
      endOffsetSeconds: cleanTime(Math.max(0, w.endOffsetSeconds - offset)),
    })),
  };
}

/**
 * Split `el` at timeline time `at`. The left part keeps the id; returns the new right part,
 * or `null` when the split is impossible (too close to an edge, or a caption side would be empty).
 */
export function splitElement(ctx: EditContext, el: Element, at: number): Element | null {
  const project = ctx.draft;
  assertUnlocked(project, el);
  const local = cleanTime(at - el.start);
  const minDur = minDuration(ctx);
  if (local < minDur - EPS || el.duration - local < minDur - EPS) return null;

  let captionWords: ReturnType<typeof partitionCaptionWords> | undefined;
  if (el.type === "caption") {
    captionWords = partitionCaptionWords(el, local);
    if (captionWords.left.length === 0 || captionWords.right.length === 0) {
      ctx.warn(`Caption ${el.id} not split at ${at}s (no words on one side)`);
      return null;
    }
  }

  const right = cloneElement(el);
  right.id = ctx.ids("el");
  delete right.anchor;
  const kfs = splitAllKeyframes(el, local);

  if (isSourced(el) && isSourced(right)) {
    const span = el.sourceDurationSourceSeconds;
    const p = sourcePositionAtTime(local, el.duration, el.speed);
    const leftSpeed = sliceSpeed(el.speed, 0, p);
    const rightSpeed = sliceSpeed(el.speed, p, 1);
    const leftSpan = cleanTime(span * p);
    const rightSpan = cleanTime(span - leftSpan);
    if (el.reversed) {
      right.sourceInSourceSeconds = el.sourceInSourceSeconds;
      el.sourceInSourceSeconds = cleanTime(el.sourceInSourceSeconds + rightSpan);
    } else {
      right.sourceInSourceSeconds = cleanTime(el.sourceInSourceSeconds + leftSpan);
    }
    el.sourceDurationSourceSeconds = leftSpan;
    right.sourceDurationSourceSeconds = rightSpan;
    el.speed = leftSpeed;
    right.speed = rightSpeed;
    el.duration = timelineDurationFor(leftSpan, leftSpeed);
    right.duration = timelineDurationFor(rightSpan, rightSpeed);
    right.fadeInSeconds = 0;
    el.fadeOutSeconds = 0;
    if (right.type === "video") delete right.linkedAudioId;
    if (right.type === "audio") delete right.linkedVideoId;
  } else {
    el.duration = local;
    right.duration = cleanTime(right.duration - local);
  }
  right.start = cleanTime(el.start + el.duration);
  el.keyframes = kfs.left;
  right.keyframes = kfs.right;
  if (el.type === "caption" && right.type === "caption" && captionWords) {
    el.words = captionWords.left;
    right.words = captionWords.right;
  }

  project.elements[right.id] = right;
  const track = trackOf(project, el);
  const idx = track.elementIds.indexOf(el.id);
  track.elementIds.splice(idx + 1, 0, right.id);
  if (isOnMain(project, el)) {
    for (const tr of project.transitions) if (tr.fromElementId === el.id) tr.fromElementId = right.id;
  } else {
    ctx.positioned.add(right.id);
    ctx.positioned.add(el.id);
  }
  ctx.touch(el.id, right.id);
  ctx.created.push(right.id);
  return right;
}

export type SplitSnapMode = "projectFrame" | "sourceFrameCeil" | "none";

export interface SplitAtOptions {
  times: number[];
  snap?: SplitSnapMode;
  elementIds?: string[];
  trackIds?: string[];
  /** Split elements on every track (default: main track only unless elementIds/trackIds given). */
  allTracks?: boolean;
}

export const MAX_SPLIT_TIMES = 1000;

function snapForElement(ctx: EditContext, el: Element, t: number, mode: SplitSnapMode): number {
  if (mode === "none") return t;
  const fps = ctx.draft.canvas.fps;
  if (mode === "sourceFrameCeil" && isSourced(el) && el.speed.mode === "constant") {
    const media = ctx.draft.media[el.mediaId];
    const srcFps = media?.fps;
    if (srcFps) {
      const local = t - el.start;
      const src = el.reversed
        ? el.sourceInSourceSeconds + el.sourceDurationSourceSeconds - local * el.speed.rate
        : el.sourceInSourceSeconds + local * el.speed.rate;
      const snappedSrc = sourceFrameCeil(src, srcFps);
      const newLocal = el.reversed
        ? (el.sourceInSourceSeconds + el.sourceDurationSourceSeconds - snappedSrc) / el.speed.rate
        : (snappedSrc - el.sourceInSourceSeconds) / el.speed.rate;
      return cleanTime(el.start + newLocal);
    }
  }
  return snapProjectFrame(t, fps);
}

/** Split many elements at many times as part of one transaction. */
export function splitAt(ctx: EditContext, opts: SplitAtOptions): { splits: number; createdIds: string[]; skipped: number } {
  const project = ctx.draft;
  if (opts.times.length === 0) throw new EditError("INVALID_ARGUMENT", "times must not be empty");
  if (opts.times.length > MAX_SPLIT_TIMES) throw new EditError("INVALID_ARGUMENT", `At most ${MAX_SPLIT_TIMES} split times per call`, { count: opts.times.length });
  const mode = opts.snap ?? "projectFrame";

  let scope: Set<string>;
  if (opts.elementIds?.length) {
    for (const id of opts.elementIds) requireElement(project, id);
    scope = new Set(opts.elementIds);
  } else if (opts.trackIds?.length || opts.allTracks) {
    const tracks = opts.allTracks ? project.tracks : project.tracks.filter((t) => opts.trackIds!.includes(t.id));
    if (!opts.allTracks && tracks.length !== opts.trackIds!.length) throw new EditError("TRACK_NOT_FOUND", "One or more trackIds do not exist", { trackIds: opts.trackIds });
    scope = new Set(tracks.filter((t) => !t.locked).flatMap((t) => t.elementIds));
  } else {
    scope = new Set(mainTrack(project).elementIds);
  }

  // Plain list of in-scope elements sorted by start for fast lookup.
  let active = [...scope].map((id) => project.elements[id]).sort((a, b) => a.start - b.start);
  const times = [...opts.times].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const created: string[] = [];
  let skipped = 0;
  for (const raw of times) {
    const next: Element[] = [];
    let hit = false;
    for (const el of active) {
      const end = el.start + el.duration;
      if (raw > el.start + EPS && raw < end - EPS) {
        hit = true;
        const t = snapForElement(ctx, el, raw, mode);
        const right = t > el.start + EPS && t < end - EPS ? splitElement(ctx, el, t) : null;
        if (right) {
          created.push(right.id);
          next.push(el, right);
        } else {
          skipped++;
          next.push(el);
        }
      } else if (end > raw - EPS) {
        next.push(el);
      }
      // Elements that end before `raw` can never be split by later (larger) times.
    }
    if (!hit) skipped++;
    active = next;
  }
  return { splits: created.length, createdIds: created, skipped };
}

// ---------------------------------------------------------------- trimming

function mediaTotal(ctx: EditContext, el: SourcedElement): number {
  return ctx.draft.media[el.mediaId]?.durationSourceSeconds ?? Infinity;
}

/**
 * Trim a sourced element. Positive delta shortens, negative extends (clamped to media handles).
 * Returns the actual timeline duration removed (negative when extended).
 */
function trimSourced(ctx: EditContext, el: SourcedElement, side: "left" | "right", delta: number): number {
  const span = el.sourceDurationSourceSeconds;
  const dur = el.duration;
  const minDur = minDuration(ctx);
  let newIn = el.sourceInSourceSeconds;
  let newSpan: number;
  let newSpeed = el.speed;
  if (delta > 0) {
    const d = Math.min(delta, dur - minDur);
    if (d <= EPS) {
      ctx.warn(`Element ${el.id} is already at its minimum duration`);
      return 0;
    }
    const pCut = side === "left" ? sourcePositionAtTime(d, dur, el.speed) : sourcePositionAtTime(dur - d, dur, el.speed);
    const [p0, p1] = side === "left" ? [pCut, 1] : [0, pCut];
    newSpan = span * (p1 - p0);
    newSpeed = sliceSpeed(el.speed, p0, p1);
    newIn = el.reversed ? el.sourceInSourceSeconds + (1 - p1) * span : el.sourceInSourceSeconds + p0 * span;
  } else {
    const ext = -delta;
    const edgeRate = el.speed.mode === "constant" ? el.speed.rate : rateAt(el.speed.points, side === "left" ? 0 : 1);
    const addsBefore = (side === "left") !== el.reversed;
    const available = addsBefore ? el.sourceInSourceSeconds : mediaTotal(ctx, el) - (el.sourceInSourceSeconds + span);
    let srcExt = ext * edgeRate;
    if (srcExt > available + EPS) {
      ctx.warn(`Element ${el.id} extended only ${(available / edgeRate).toFixed(3)}s (end of source media)`);
      srcExt = Math.max(0, available);
    }
    if (srcExt <= EPS) return 0;
    newSpan = span + srcExt;
    if (el.speed.mode === "curve") {
      const f = srcExt / newSpan;
      const pts = el.speed.points;
      newSpeed = {
        mode: "curve",
        preset: el.speed.preset,
        points:
          side === "left"
            ? [{ position: 0, rate: edgeRate }, ...pts.map((p) => ({ ...p, position: f + p.position * (1 - f) }))]
            : [...pts.map((p) => ({ ...p, position: p.position * (1 - f) })), { position: 1, rate: edgeRate }],
      };
    }
    if (addsBefore) newIn = el.sourceInSourceSeconds - srcExt;
  }
  el.sourceInSourceSeconds = cleanTime(Math.max(0, newIn));
  el.sourceDurationSourceSeconds = cleanTime(newSpan);
  el.speed = newSpeed;
  el.duration = timelineDurationFor(el.sourceDurationSourceSeconds, el.speed);
  return cleanTime(dur - el.duration);
}

function trimKeyframesAll(el: Element, side: "left" | "right", removed: number) {
  const out: Keyframes = {};
  for (const [prop, kfs] of Object.entries(el.keyframes) as [KeyframeProperty, NonNullable<Keyframes[KeyframeProperty]>][]) {
    if (!kfs || kfs.length === 0) continue;
    out[prop] = side === "left" ? trimKeyframesHead(kfs, removed, keyframeFallback(el, prop)) : trimKeyframesTail(kfs, el.duration, keyframeFallback(el, prop));
  }
  el.keyframes = out;
}

function trimCaptionWords(ctx: EditContext, el: CaptionElement, side: "left" | "right", removed: number) {
  if (side === "left") {
    el.words = el.words
      .map((w) => ({ ...w, startOffsetSeconds: cleanTime(w.startOffsetSeconds - removed), endOffsetSeconds: cleanTime(w.endOffsetSeconds - removed) }))
      .filter((w) => w.endOffsetSeconds > EPS)
      .map((w) => ({ ...w, startOffsetSeconds: Math.max(0, w.startOffsetSeconds) }));
  } else {
    el.words = el.words
      .filter((w) => w.startOffsetSeconds < el.duration - EPS)
      .map((w) => ({ ...w, endOffsetSeconds: Math.min(w.endOffsetSeconds, el.duration) }));
  }
  if (el.words.length === 0) throw new EditError("INVALID_RANGE", `Trim would remove every word from caption ${el.id}`);
  void ctx;
}

/**
 * Trim an element edge. `deltaSeconds` > 0 shortens, < 0 extends.
 * On the magnetic main track the element keeps its start and downstream clips ripple.
 */
export function trimElement(ctx: EditContext, el: Element, side: "left" | "right", deltaSeconds: number): number {
  const project = ctx.draft;
  assertUnlocked(project, el);
  if (side === "left" && !isOnMain(project, el) && deltaSeconds < -el.start) {
    ctx.warn(`Element ${el.id} cannot extend before 0s`);
    deltaSeconds = -el.start;
  }
  const before = el.duration;
  let removed: number;
  if (isSourced(el)) {
    removed = trimSourced(ctx, el, side, deltaSeconds);
  } else {
    const minDur = minDuration(ctx);
    let next = el.duration - deltaSeconds;
    if (next < minDur) {
      ctx.warn(`Element ${el.id} clamped to minimum duration`);
      next = minDur;
    }
    el.duration = cleanTime(next);
    removed = cleanTime(before - el.duration);
  }
  if (Math.abs(removed) <= EPS) return 0;
  if (!isOnMain(project, el)) {
    if (side === "left") el.start = cleanTime(Math.max(0, el.start + removed));
    ctx.positioned.add(el.id);
  }
  trimKeyframesAll(el, side, removed);
  if (el.type === "caption") trimCaptionWords(ctx, el, side, removed);
  if (isSourced(el)) {
    el.fadeInSeconds = Math.min(el.fadeInSeconds, el.duration);
    el.fadeOutSeconds = Math.min(el.fadeOutSeconds, el.duration);
  }
  ctx.touch(el.id);
  return removed;
}

/** Trim the head so the element starts (content-wise) at timeline time `time`. */
export function trimStartTo(ctx: EditContext, el: Element, time: number): number {
  if (time >= elementEnd(el) - EPS) throw new EditError("INVALID_RANGE", `trimStart time ${time} is at or after the element end ${elementEnd(el)}`);
  return trimElement(ctx, el, "left", time - el.start);
}

/** Trim the tail so the element ends at timeline time `time`. */
export function trimEndTo(ctx: EditContext, el: Element, time: number): number {
  if (time <= el.start + EPS) throw new EditError("INVALID_RANGE", `trimEnd time ${time} is at or before the element start ${el.start}`);
  return trimElement(ctx, el, "right", elementEnd(el) - time);
}

/** Shift the source window of a sourced element without changing its timeline position. */
export function slipElement(ctx: EditContext, el: Element, deltaSourceSeconds: number): number {
  if (!isSourced(el)) throw new EditError("INVALID_ELEMENT_TYPE", `slipClip needs a video or audio element; ${el.id} is ${el.type}`);
  assertUnlocked(ctx.draft, el);
  const total = mediaTotal(ctx, el);
  const max = total - el.sourceDurationSourceSeconds;
  const next = Math.min(Math.max(0, el.sourceInSourceSeconds + deltaSourceSeconds), Math.max(0, max));
  const actual = cleanTime(next - el.sourceInSourceSeconds);
  if (Math.abs(actual - deltaSourceSeconds) > EPS) ctx.warn(`Slip clamped to ${actual.toFixed(3)}s by the source media bounds`);
  el.sourceInSourceSeconds = cleanTime(next);
  ctx.touch(el.id);
  return actual;
}

/** Delete elements. Main-track deletions ripple when the magnet is on. */
export function deleteElements(ctx: EditContext, ids: string[]) {
  const project = ctx.draft;
  for (const id of ids) {
    const el = requireElement(project, id);
    assertUnlocked(project, el);
  }
  for (const id of ids) {
    const el = project.elements[id];
    if (!el) continue;
    detachFromTrack(project, el);
    if (el.type === "video" && el.linkedAudioId) {
      const a = project.elements[el.linkedAudioId];
      if (a && a.type === "audio") delete a.linkedVideoId;
    }
    if (el.type === "audio" && el.linkedVideoId) {
      const v = project.elements[el.linkedVideoId];
      if (v && v.type === "video") delete v.linkedAudioId;
    }
    delete project.elements[id];
    ctx.removed.push(id);
  }
  project.transitions = project.transitions.filter((t) => project.elements[t.fromElementId] && project.elements[t.toElementId]);
}
