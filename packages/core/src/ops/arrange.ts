import type { AudioElement, Element, MediaAsset, Track } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import { defaultAudioProps, defaultTransform } from "../defaults.js";
import {
  assertUnlocked,
  compatibleKinds,
  defaultKindFor,
  elementEnd,
  isAudioKind,
  isCompatible,
  isOnMain,
  mainTrack,
  requireElement,
  requireTrack,
} from "../timeline/query.js";
import { attachToTrack, detachFromTrack, findOrCreateLane, hasRoom, insertTrack } from "../timeline/tracks.js";
import { snapTime } from "../timeline/snapping.js";
import { timelineDurationFor } from "../speed.js";
import type { EditContext } from "./context.js";
import { buildMediaElement, cloneElement, plainClone, type MediaElementOptions } from "./elements.js";
import { splitElement } from "./edit.js";

/** Index in the main track where an element starting at `time` would land. */
export function mainIndexAtTime(ctx: EditContext, time: number, excludeId?: string): number {
  const project = ctx.draft;
  const ids = mainTrack(project).elementIds.filter((id) => id !== excludeId);
  let idx = 0;
  for (const id of ids) {
    const el = project.elements[id];
    if (el.start + el.duration / 2 < time - EPS) idx++;
  }
  return idx;
}

/**
 * Insert an element into the main track. `atTime` inside a clip splits that clip and inserts
 * between the halves; at a boundary it inserts there. Defaults to appending.
 */
export function insertIntoMain(ctx: EditContext, el: Element, opts: { index?: number; atTime?: number } = {}) {
  const project = ctx.draft;
  const main = mainTrack(project);
  if (main.locked) throw new EditError("TRACK_LOCKED", "The main track is locked");
  if (el.type !== "video" && el.type !== "image") throw new EditError("INCOMPATIBLE_TRACK", `${el.type} elements cannot go on the main track`);
  let index = main.elementIds.length;
  if (opts.index !== undefined) index = Math.max(0, Math.min(opts.index, main.elementIds.length));
  else if (opts.atTime !== undefined) {
    const t = opts.atTime;
    index = main.elementIds.length;
    for (let i = 0; i < main.elementIds.length; i++) {
      const cur = project.elements[main.elementIds[i]];
      if (Math.abs(cur.start - t) <= EPS) {
        index = i;
        break;
      }
      if (t > cur.start + EPS && t < cur.start + cur.duration - EPS) {
        const right = splitElement(ctx, cur, t);
        index = right ? i + 1 : t - cur.start < cur.duration / 2 ? i : i + 1;
        break;
      }
    }
  }
  if (!project.elements[el.id]) project.elements[el.id] = el;
  detachFromTrack(project, el);
  el.trackId = main.id;
  delete el.anchor;
  main.elementIds.splice(index, 0, el.id);
  ctx.touch(el.id);
}

/** Add a media asset to the timeline. Video/images go to the main track unless `asOverlay`. */
export function addMediaToTimeline(
  ctx: EditContext,
  media: MediaAsset,
  opts: Omit<MediaElementOptions, "trackId" | "start"> & { start?: number; index?: number; asOverlay?: boolean; trackId?: string },
): Element {
  const project = ctx.draft;
  const visual = media.kind !== "audio" && media.hasVideo !== false;
  const toMain = visual && !opts.asOverlay && !opts.trackId;
  if (toMain) {
    const el = buildMediaElement(ctx, media, { ...opts, trackId: mainTrack(project).id, start: 0, transform: { fit: "cover", ...opts.transform } });
    project.elements[el.id] = el;
    insertIntoMain(ctx, el, { index: opts.index, atTime: opts.start });
    ctx.created.push(el.id);
    return el;
  }
  const start = opts.start ?? 0;
  const el = buildMediaElement(ctx, media, {
    ...opts,
    trackId: "",
    start,
    transform: visual ? { fit: "contain", scale: 0.6, ...opts.transform } : opts.transform,
  });
  project.elements[el.id] = el;
  let lane: Track;
  if (opts.trackId) {
    lane = requireTrack(project, opts.trackId);
    if (!isCompatible(el, lane)) throw new EditError("INCOMPATIBLE_TRACK", `A ${el.type} element cannot go on a ${lane.kind} track`);
    if (lane.kind === "main") {
      delete project.elements[el.id];
      return addMediaToTimeline(ctx, media, { ...opts, trackId: undefined, asOverlay: false });
    }
  } else {
    lane = findOrCreateLane(ctx, defaultKindFor(el), start, start + el.duration, { excludeId: el.id });
  }
  attachToTrack(project, el, lane);
  ctx.positioned.add(el.id);
  ctx.touch(el.id);
  ctx.created.push(el.id);
  return el;
}

/** Place a newly built free element on a lane of its default kind. */
export function placeFreeElement(ctx: EditContext, el: Element, preferTrackId?: string) {
  const project = ctx.draft;
  project.elements[el.id] = el;
  let lane: Track | undefined;
  if (preferTrackId) {
    lane = requireTrack(project, preferTrackId);
    if (!isCompatible(el, lane) || lane.kind === "main") throw new EditError("INCOMPATIBLE_TRACK", `A ${el.type} element cannot go on a ${lane.kind} track`);
  }
  const target = findOrCreateLane(ctx, lane?.kind ?? defaultKindFor(el), el.start, el.start + el.duration, { preferTrackId, excludeId: el.id });
  attachToTrack(project, el, target);
  ctx.positioned.add(el.id);
  ctx.touch(el.id);
  ctx.created.push(el.id);
}

export interface MoveOptions {
  start?: number;
  trackId?: string;
  snap?: boolean;
  playheadSeconds?: number;
}

/** Move an element in time and/or to another track. Main-track clips are reordered. */
export function moveElement(ctx: EditContext, el: Element, opts: MoveOptions): { start: number; snapped: boolean } {
  const project = ctx.draft;
  assertUnlocked(project, el);
  let start = opts.start ?? el.start;
  let snapped = false;
  if (opts.start !== undefined && (opts.snap ?? project.rippleSettings.snappingEnabled)) {
    const s = snapTime(project, opts.start, { excludeElementIds: [el.id], playheadSeconds: opts.playheadSeconds });
    // Also try snapping the element's end.
    const e = snapTime(project, opts.start + el.duration, { excludeElementIds: [el.id], playheadSeconds: opts.playheadSeconds });
    if (s.snapped && (!e.snapped || Math.abs(s.time - opts.start) <= Math.abs(e.time - (opts.start + el.duration)))) {
      start = s.time;
      snapped = true;
    } else if (e.snapped) {
      start = e.time - el.duration;
      snapped = true;
    }
  }
  if (start < 0) start = 0;

  const target = opts.trackId ? requireTrack(project, opts.trackId) : undefined;
  if (target?.locked) throw new EditError("TRACK_LOCKED", `Track "${target.name}" is locked`);
  if (target && !isCompatible(el, target)) throw new EditError("INCOMPATIBLE_TRACK", `A ${el.type} element cannot go on a ${target.kind} track`, { allowedKinds: compatibleKinds(el) });

  if (isOnMain(project, el)) {
    if (target && target.kind !== "main") {
      convertToOverlay(ctx, el, { start, trackId: target.id });
      return { start, snapped };
    }
    if (opts.start !== undefined && project.rippleSettings.magnetEnabled) {
      reorderMain(ctx, el, mainIndexAtTime(ctx, start, el.id));
    } else if (opts.start !== undefined) {
      el.start = cleanTime(start);
    }
    ctx.touch(el.id);
    return { start: el.start, snapped };
  }
  if (target && target.kind === "main") {
    convertToMain(ctx, el, { index: mainIndexAtTime(ctx, start) });
    return { start: el.start, snapped };
  }
  el.start = cleanTime(start);
  if (target) attachToTrack(project, el, target);
  ctx.positioned.add(el.id);
  ctx.touch(el.id);
  return { start: el.start, snapped };
}

export function reorderMain(ctx: EditContext, el: Element, toIndex: number) {
  const main = mainTrack(ctx.draft);
  if (!isOnMain(ctx.draft, el)) throw new EditError("INVALID_ARGUMENT", `reorderClip only applies to main-track clips; ${el.id} is on ${el.trackId}`);
  assertUnlocked(ctx.draft, el);
  const ids = main.elementIds.filter((id) => id !== el.id);
  const idx = Math.max(0, Math.min(toIndex, ids.length));
  ids.splice(idx, 0, el.id);
  main.elementIds = ids;
  ctx.touch(el.id);
}

export type LayerDirection = "up" | "down" | "top" | "bottom";

/** Move a free element to another lane, either a specific track or relative to its current lane. */
export function moveToLayer(ctx: EditContext, el: Element, opts: { trackId?: string; direction?: LayerDirection }): Track {
  const project = ctx.draft;
  assertUnlocked(project, el);
  if (isOnMain(project, el)) throw new EditError("INVALID_ARGUMENT", "Main-track clips have no layer; use convertToOverlay first");
  if (opts.trackId) {
    const t = requireTrack(project, opts.trackId);
    if (t.kind === "main") throw new EditError("INVALID_ARGUMENT", "Use convertToMain to move an element onto the main track");
    if (!isCompatible(el, t)) throw new EditError("INCOMPATIBLE_TRACK", `A ${el.type} element cannot go on a ${t.kind} track`);
    if (t.locked) throw new EditError("TRACK_LOCKED", `Track "${t.name}" is locked`);
    attachToTrack(project, el, t);
    ctx.positioned.add(el.id);
    ctx.touch(el.id);
    return t;
  }
  const dir = opts.direction ?? "up";
  const current = requireTrack(project, el.trackId);
  const audio = isAudioKind(current.kind);
  const peers = project.tracks.filter((t, i) => i > 0 && isAudioKind(t.kind) === audio);
  const pos = peers.indexOf(current);
  const kind = current.kind;
  const end = el.start + el.duration;
  let dest: Track | undefined;
  const tryUse = (t: Track | undefined) => (t && t.kind === kind && !t.locked && hasRoom(project, t, el.start, end, el.id) ? t : undefined);
  if (dir === "up" || dir === "top") {
    const neighbor = dir === "up" ? peers[pos + 1] : peers[peers.length - 1];
    if (!neighbor || neighbor === current) {
      if (current.elementIds.length === 1) return current;
      dest = insertTrack(ctx, kind, current.id);
    } else dest = tryUse(neighbor) ?? insertTrack(ctx, kind, neighbor.id);
  } else {
    const neighbor = dir === "down" ? peers[pos - 1] : peers[0];
    if (!neighbor || neighbor === current) {
      if (current.elementIds.length === 1) return current;
      const below = project.tracks[project.tracks.indexOf(current) - 1];
      dest = insertTrack(ctx, kind, below?.id);
    } else {
      const reuse = tryUse(neighbor);
      if (reuse) dest = reuse;
      else {
        const below = project.tracks[project.tracks.indexOf(neighbor) - 1];
        dest = insertTrack(ctx, kind, below?.id);
      }
    }
  }
  attachToTrack(project, el, dest);
  ctx.positioned.add(el.id);
  ctx.touch(el.id);
  return dest;
}

/** Move a main-track clip onto an overlay lane (the main track closes the gap). */
export function convertToOverlay(ctx: EditContext, el: Element, opts: { start?: number; trackId?: string } = {}) {
  const project = ctx.draft;
  if (!isOnMain(project, el)) throw new EditError("INVALID_ARGUMENT", `${el.id} is not on the main track`);
  assertUnlocked(project, el);
  const start = opts.start ?? el.start;
  detachFromTrack(project, el);
  el.start = cleanTime(start);
  const lane = opts.trackId
    ? requireTrack(project, opts.trackId)
    : findOrCreateLane(ctx, "overlay", el.start, el.start + el.duration, { excludeId: el.id });
  if (!isCompatible(el, lane) || lane.kind === "main") throw new EditError("INCOMPATIBLE_TRACK", `Cannot convert to overlay on a ${lane.kind} track`);
  attachToTrack(project, el, lane);
  ctx.positioned.add(el.id);
  ctx.touch(el.id);
}

/** Move a free video/image element onto the main track. */
export function convertToMain(ctx: EditContext, el: Element, opts: { index?: number } = {}) {
  const project = ctx.draft;
  if (isOnMain(project, el)) throw new EditError("INVALID_ARGUMENT", `${el.id} is already on the main track`);
  if (el.type !== "video" && el.type !== "image") throw new EditError("INCOMPATIBLE_TRACK", `${el.type} elements cannot go on the main track`);
  assertUnlocked(project, el);
  const index = opts.index ?? mainIndexAtTime(ctx, el.start);
  el.transform = defaultTransform({ fit: "cover" });
  insertIntoMain(ctx, el, { index });
}

/** Duplicate an element; main clips are inserted right after the original. */
export function duplicateElement(ctx: EditContext, el: Element): Element {
  const project = ctx.draft;
  const copy = cloneElement(el);
  copy.id = ctx.ids("el");
  delete copy.anchor;
  if (copy.type === "video") delete copy.linkedAudioId;
  if (copy.type === "audio") delete copy.linkedVideoId;
  project.elements[copy.id] = copy;
  ctx.created.push(copy.id);
  if (isOnMain(project, el)) {
    const main = mainTrack(project);
    main.elementIds.splice(main.elementIds.indexOf(el.id) + 1, 0, copy.id);
    ctx.touch(copy.id);
    return copy;
  }
  copy.start = elementEnd(el);
  const kind = requireTrack(project, el.trackId).kind;
  const lane = findOrCreateLane(ctx, kind, copy.start, copy.start + copy.duration, { preferTrackId: el.trackId, excludeId: copy.id });
  attachToTrack(project, copy, lane);
  ctx.positioned.add(copy.id);
  ctx.touch(copy.id);
  return copy;
}

/** Detach a video's audio into a linked audio element and mute the video's own audio. */
export function extractAudio(ctx: EditContext, el: Element): AudioElement {
  const project = ctx.draft;
  if (el.type !== "video") throw new EditError("INVALID_ELEMENT_TYPE", `extractAudio needs a video element; ${el.id} is ${el.type}`);
  const media = project.media[el.mediaId];
  if (!media?.hasAudio) throw new EditError("UNSUPPORTED_MEDIA", `Media for ${el.id} has no audio stream`);
  if (el.audioDetached) throw new EditError("INVALID_ARGUMENT", `Audio for ${el.id} was already extracted`, { linkedAudioId: el.linkedAudioId });
  const audio: AudioElement = {
    type: "audio",
    id: ctx.ids("el"),
    trackId: "",
    name: `${el.name ?? media.name} (audio)`,
    start: el.start,
    duration: timelineDurationFor(el.sourceDurationSourceSeconds, el.speed),
    mediaId: el.mediaId,
    sourceInSourceSeconds: el.sourceInSourceSeconds,
    sourceDurationSourceSeconds: el.sourceDurationSourceSeconds,
    speed: plainClone(el.speed),
    reversed: el.reversed,
    ...defaultAudioProps(),
    volume: el.volume,
    fadeInSeconds: el.fadeInSeconds,
    fadeOutSeconds: el.fadeOutSeconds,
    voiceEnhance: plainClone(el.voiceEnhance),
    keyframes: el.keyframes.volume ? { volume: el.keyframes.volume.map((k) => ({ ...k })) } : {},
    role: "extracted",
    linkedVideoId: el.id,
  };
  project.elements[audio.id] = audio;
  const lane = findOrCreateLane(ctx, "audio", audio.start, audio.start + audio.duration, { excludeId: audio.id });
  attachToTrack(project, audio, lane);
  el.audioDetached = true;
  el.linkedAudioId = audio.id;
  ctx.positioned.add(audio.id);
  ctx.touch(el.id, audio.id);
  ctx.created.push(audio.id);
  return audio;
}

/** Swap the media under an element, keeping its timeline slot and look where possible. */
export function replaceElementMedia(ctx: EditContext, el: Element, media: MediaAsset) {
  const project = ctx.draft;
  assertUnlocked(project, el);
  if (el.type === "video" || el.type === "image") {
    if (media.kind === "audio" || !media.hasVideo) throw new EditError("UNSUPPORTED_MEDIA", "Replacement for a visual element must be a video or image");
    const next = buildMediaElement(ctx, media, { trackId: el.trackId, start: el.start, durationSeconds: el.duration, name: media.name });
    if (next.type === "audio") throw new EditError("UNSUPPORTED_MEDIA", "Replacement must contain video");
    Object.assign(next, {
      id: el.id,
      transform: el.transform,
      opacity: el.opacity,
      blendMode: el.blendMode,
      mask: el.mask,
      keyframes: el.keyframes,
      color: el.color,
      effects: el.effects,
      flip: el.flip,
      ...(el.anchor ? { anchor: el.anchor } : {}),
    });
    if (next.type === "video" && el.type === "video") {
      Object.assign(next, {
        volume: el.volume,
        muted: el.muted,
        fadeInSeconds: Math.min(el.fadeInSeconds, next.duration),
        fadeOutSeconds: Math.min(el.fadeOutSeconds, next.duration),
        voiceEnhance: el.voiceEnhance,
        ducking: el.ducking,
      });
    }
    if (next.duration < el.duration - EPS) ctx.warn(`Replacement media is shorter; element shortened to ${next.duration.toFixed(3)}s`);
    project.elements[el.id] = next;
  } else if (el.type === "audio") {
    if (!media.hasAudio || media.durationSourceSeconds === undefined) throw new EditError("UNSUPPORTED_MEDIA", "Replacement for an audio element must contain audio");
    const total = media.durationSourceSeconds;
    el.mediaId = media.id;
    el.name = media.name;
    if (total < el.sourceDurationSourceSeconds) {
      el.sourceInSourceSeconds = 0;
      el.sourceDurationSourceSeconds = cleanTime(total);
      el.duration = timelineDurationFor(el.sourceDurationSourceSeconds, el.speed);
      ctx.warn(`Replacement media is shorter; element shortened to ${el.duration.toFixed(3)}s`);
    } else if (el.sourceInSourceSeconds + el.sourceDurationSourceSeconds > total) {
      el.sourceInSourceSeconds = cleanTime(total - el.sourceDurationSourceSeconds);
    }
  } else {
    throw new EditError("INVALID_ELEMENT_TYPE", `Cannot replace media on a ${el.type} element`);
  }
  if (!isOnMain(project, el)) ctx.positioned.add(el.id);
  ctx.touch(el.id);
}

export { requireElement };
