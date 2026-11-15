import type { BeatMarker, Canvas, ExportSettings, MediaAsset, MediaFolder, Project, RippleSettings } from "../schema.js";
import { BeatDensitySchema } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import type { EditContext } from "./context.js";
import { reanchor } from "../timeline/finalize.js";
import { z } from "zod";

export function setCanvas(ctx: EditContext, patch: Partial<Canvas>) {
  // Positions are normalized, so nothing else needs to change.
  Object.assign(ctx.draft.canvas, patch);
  if (patch.backgroundColor) ctx.draft.canvas.backgroundColor = patch.backgroundColor.toUpperCase();
}

export function setRippleTiers(ctx: EditContext, patch: Partial<RippleSettings>) {
  Object.assign(ctx.draft.rippleSettings, patch);
  reanchor(ctx.draft);
}

export function setExportSettings(ctx: EditContext, patch: Partial<ExportSettings>) {
  Object.assign(ctx.draft.exportSettings, patch);
}

export function setTeleprompter(ctx: EditContext, patch: Partial<Project["teleprompter"]>) {
  Object.assign(ctx.draft.teleprompter, patch);
}

export function renameProjectDoc(ctx: EditContext, name: string) {
  ctx.draft.name = name;
}

export function addMediaAssets(ctx: EditContext, assets: MediaAsset[]) {
  for (const a of assets) ctx.draft.media[a.id] = a;
}

export function addMediaFolder(ctx: EditContext, name: string, parentId?: string): MediaFolder {
  if (parentId && !ctx.draft.mediaFolders.some((f) => f.id === parentId)) throw new EditError("INVALID_ARGUMENT", `No media folder ${parentId}`);
  const folder: MediaFolder = { id: ctx.ids("fld"), name, ...(parentId ? { parentId } : {}) };
  ctx.draft.mediaFolders.push(folder);
  return folder;
}

export function addBeatMarker(ctx: EditContext, timeSeconds: number, strength?: number): BeatMarker {
  const existing = ctx.draft.beatMarkers.find((m) => Math.abs(m.timeSeconds - timeSeconds) <= EPS);
  if (existing) return existing;
  const m: BeatMarker = { id: ctx.ids("bm"), timeSeconds: cleanTime(timeSeconds), source: "manual", ...(strength !== undefined ? { strength } : {}) };
  ctx.draft.beatMarkers.push(m);
  ctx.draft.beatMarkers.sort((a, b) => a.timeSeconds - b.timeSeconds);
  return m;
}

export function removeBeatMarker(ctx: EditContext, id: string) {
  const before = ctx.draft.beatMarkers.length;
  ctx.draft.beatMarkers = ctx.draft.beatMarkers.filter((m) => m.id !== id);
  if (ctx.draft.beatMarkers.length === before) throw new EditError("INVALID_ARGUMENT", `No beat marker ${id}`);
}

export function setBeatDensity(ctx: EditContext, density: z.infer<typeof BeatDensitySchema>) {
  ctx.draft.beatDensity = density;
}

export function setBrief(ctx: EditContext, brief: string) {
  ctx.draft.brief = brief;
}

export function setTrackFlags(ctx: EditContext, trackId: string, flags: { locked?: boolean; hidden?: boolean; muted?: boolean; name?: string }) {
  const t = ctx.draft.tracks.find((x) => x.id === trackId);
  if (!t) throw new EditError("TRACK_NOT_FOUND", `No track ${trackId}`);
  Object.assign(t, flags);
}

/** Replace all auto-detected beat markers (manual markers are kept). */
export function setAutoBeatMarkers(ctx: EditContext, beats: { timeSeconds: number; strength?: number }[]): number {
  const manual = ctx.draft.beatMarkers.filter((m) => m.source === "manual");
  const auto: BeatMarker[] = [];
  for (const b of beats) {
    if (b.timeSeconds < 0 || manual.some((m) => Math.abs(m.timeSeconds - b.timeSeconds) <= 1e-3)) continue;
    auto.push({ id: ctx.ids("bm"), timeSeconds: cleanTime(b.timeSeconds), source: "auto", ...(b.strength !== undefined ? { strength: Math.max(0, Math.min(1, b.strength)) } : {}) });
  }
  ctx.draft.beatMarkers = [...manual, ...auto].sort((a, b) => a.timeSeconds - b.timeSeconds);
  return auto.length;
}
