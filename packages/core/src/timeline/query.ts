import type { Element, MediaAsset, Project, Track, TrackKind } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";

export function mainTrack(project: Project): Track {
  return project.tracks[0];
}

export function elementEnd(el: { start: number; duration: number }): number {
  return cleanTime(el.start + el.duration);
}

export function getElement(project: Project, id: string): Element | undefined {
  return project.elements[id];
}

export function requireElement(project: Project, id: string): Element {
  const el = project.elements[id];
  if (!el) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${id}"`, { elementId: id });
  return el;
}

export function requireElementOfType<T extends Element["type"]>(
  project: Project,
  id: string,
  types: readonly T[],
): Extract<Element, { type: T }> {
  const el = requireElement(project, id);
  if (!(types as readonly string[]).includes(el.type)) {
    throw new EditError("INVALID_ELEMENT_TYPE", `Element "${id}" is a ${el.type}; expected ${types.join(" or ")}`, {
      elementId: id,
      type: el.type,
      expected: types,
    });
  }
  return el as Extract<Element, { type: T }>;
}

export function getTrack(project: Project, id: string): Track | undefined {
  return project.tracks.find((t) => t.id === id);
}

export function requireTrack(project: Project, id: string): Track {
  const t = getTrack(project, id);
  if (!t) throw new EditError("TRACK_NOT_FOUND", `No track with id "${id}"`, { trackId: id });
  return t;
}

export function trackOf(project: Project, el: Element): Track {
  return requireTrack(project, el.trackId);
}

export function isOnMain(project: Project, el: Element): boolean {
  return el.trackId === mainTrack(project).id;
}

export function requireMedia(project: Project, id: string): MediaAsset {
  const m = project.media[id];
  if (!m) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${id}"`, { mediaId: id });
  return m;
}

export function assertUnlocked(project: Project, el: Element) {
  const t = trackOf(project, el);
  if (t.locked) throw new EditError("TRACK_LOCKED", `Track "${t.name}" is locked`, { trackId: t.id, elementId: el.id });
}

/** End time of the last element on any track. */
export function compositionDuration(project: Project): number {
  let end = 0;
  for (const el of Object.values(project.elements)) end = Math.max(end, el.start + el.duration);
  return cleanTime(end);
}

export function mainTrackDuration(project: Project): number {
  const main = mainTrack(project);
  let end = 0;
  for (const id of main.elementIds) {
    const el = project.elements[id];
    if (el) end = Math.max(end, el.start + el.duration);
  }
  return cleanTime(end);
}

/** Elements active at `time` (start <= time < end). */
export function elementsAtTime(project: Project, time: number): Element[] {
  return Object.values(project.elements).filter((el) => el.start <= time + EPS && time < el.start + el.duration - EPS);
}

/** Main-track element under `time`, if any. */
export function mainElementAt(project: Project, time: number): Element | undefined {
  for (const id of mainTrack(project).elementIds) {
    const el = project.elements[id];
    if (el && el.start <= time + EPS && time < el.start + el.duration - EPS) return el;
  }
  return undefined;
}

export const VISUAL_TRACK_KINDS: TrackKind[] = ["main", "overlay", "adjustment", "shape", "text", "sticker", "caption"];
export const AUDIO_TRACK_KINDS: TrackKind[] = ["music", "sfx", "voiceover", "audio"];

export function isAudioKind(kind: TrackKind): boolean {
  return AUDIO_TRACK_KINDS.includes(kind);
}

/** Default free-track kind for an element. */
export function defaultKindFor(el: Element): TrackKind {
  switch (el.type) {
    case "video":
    case "image":
      return "overlay";
    case "audio":
      return el.role === "music" ? "music" : el.role === "sfx" ? "sfx" : el.role === "extracted" ? "audio" : "voiceover";
    default:
      return el.type;
  }
}

/** Track kinds an element may live on. */
export function compatibleKinds(el: Element): TrackKind[] {
  switch (el.type) {
    case "video":
    case "image":
      return ["main", "overlay"];
    case "audio":
      return AUDIO_TRACK_KINDS;
    default:
      return [el.type];
  }
}

export function isCompatible(el: Element, track: Track): boolean {
  return compatibleKinds(el).includes(track.kind);
}

/** Sorted, deduplicated list of all element edges (for snapping / navigation). */
export function clipBoundaries(project: Project, trackId?: string): number[] {
  const set = new Set<number>([0]);
  for (const el of Object.values(project.elements)) {
    if (trackId && el.trackId !== trackId) continue;
    set.add(cleanTime(el.start));
    set.add(elementEnd(el));
  }
  return [...set].sort((a, b) => a - b);
}
