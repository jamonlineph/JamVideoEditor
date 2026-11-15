import type { Element, Project, Track, TrackKind } from "../schema.js";
import { makeTrack } from "../defaults.js";
import type { EditContext } from "../ops/context.js";
import { EPS } from "../units.js";
import { getTrack, isAudioKind } from "./query.js";

/** True when [start, end) on `track` does not overlap any element other than `excludeId`. */
export function hasRoom(project: Project, track: Track, start: number, end: number, excludeId?: string): boolean {
  for (const id of track.elementIds) {
    if (id === excludeId) continue;
    const other = project.elements[id];
    if (!other) continue;
    if (start < other.start + other.duration - EPS && end > other.start + EPS) return false;
  }
  return true;
}

/** Insert a new free track. Visual lanes go directly above `aboveTrackId` (or on top); audio lanes go last. */
export function insertTrack(ctx: EditContext, kind: TrackKind, aboveTrackId?: string): Track {
  const tracks = ctx.draft.tracks;
  const track = makeTrack(ctx.ids("trk"), kind);
  const sameKind = tracks.filter((t) => t.kind === kind).length;
  if (sameKind > 0) track.name = `${track.name} ${sameKind + 1}`;
  if (isAudioKind(kind)) {
    const anchorIdx = aboveTrackId ? tracks.findIndex((t) => t.id === aboveTrackId) : -1;
    if (anchorIdx >= 0 && isAudioKind(tracks[anchorIdx].kind)) tracks.splice(anchorIdx + 1, 0, track);
    else tracks.push(track);
    return track;
  }
  const firstAudio = tracks.findIndex((t) => isAudioKind(t.kind));
  const visualEnd = firstAudio === -1 ? tracks.length : firstAudio;
  let idx = visualEnd;
  if (aboveTrackId) {
    const a = tracks.findIndex((t) => t.id === aboveTrackId);
    if (a >= 0 && a < visualEnd) idx = a + 1;
  }
  tracks.splice(idx, 0, track);
  return track;
}

/**
 * Find a lane of `kind` with room for [start, end), preferring `preferTrackId` then lanes
 * above it; creates a new lane when every existing lane is occupied.
 */
export function findOrCreateLane(
  ctx: EditContext,
  kind: TrackKind,
  start: number,
  end: number,
  opts: { preferTrackId?: string; excludeId?: string } = {},
): Track {
  const project = ctx.draft;
  const lanes = project.tracks.filter((t) => t.kind === kind && !t.locked);
  const preferred = opts.preferTrackId ? getTrack(project, opts.preferTrackId) : undefined;
  const ordered: Track[] = [];
  if (preferred && preferred.kind === kind && !preferred.locked) {
    ordered.push(preferred);
    const pIdx = project.tracks.indexOf(preferred);
    for (const t of lanes) if (t !== preferred && project.tracks.indexOf(t) > pIdx) ordered.push(t);
  } else {
    ordered.push(...lanes);
  }
  for (const t of ordered) if (hasRoom(project, t, start, end, opts.excludeId)) return t;
  const top = preferred ?? lanes[lanes.length - 1];
  return insertTrack(ctx, kind, top?.id);
}

/** Move an element id from its current track to `track` (does not touch timing). */
export function attachToTrack(project: Project, el: Element, track: Track) {
  if (el.trackId === track.id && track.elementIds.includes(el.id)) return;
  const from = getTrack(project, el.trackId);
  if (from) from.elementIds = from.elementIds.filter((id) => id !== el.id);
  el.trackId = track.id;
  if (!track.elementIds.includes(el.id)) track.elementIds.push(el.id);
}

export function detachFromTrack(project: Project, el: Element) {
  const from = getTrack(project, el.trackId);
  if (from) from.elementIds = from.elementIds.filter((id) => id !== el.id);
}
