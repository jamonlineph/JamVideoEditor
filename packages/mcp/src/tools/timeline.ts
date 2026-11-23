import { z } from "zod";
import {
  EditError,
  addAdjustmentLayer,
  addMediaFolder,
  addMediaToTimeline,
  addShape,
  addSticker,
  addText,
  addTransition,
  applyFilter,
  applyLut,
  assertCatalogId,
  convertToMain,
  convertToOverlay,
  deleteElements,
  duplicateElement,
  extractAudio,
  findCatalogItem,
  moveElement,
  moveToLayer,
  reorderMain,
  replaceElementMedia,
  requireElement,
  requireMedia,
  setColorGrade,
  slipElement,
  splitAt,
  splitElement,
  trimElement,
  trimEndTo,
  trimStartTo,
  getCatalogItem,
  ColorGradeSchema,
  TextStyleSchema,
  type MediaAsset,
  type TextStyle,
} from "@openedits/core";
import { defineTool, type ToolContext } from "../defineTool.js";
import { element, expectedVersion, hexColor, mutate, pageInput, paginate, resolveElementId, round, transformInput } from "./common.js";

async function mediaFrom(ctx: ToolContext, a: { mediaId?: string; path?: string }): Promise<MediaAsset> {
  if (a.mediaId) return requireMedia(ctx.host.project, a.mediaId);
  if (a.path) return (await ctx.host.importMedia([a.path], { source: ctx.source })).assets[0];
  throw new EditError("INVALID_ARGUMENT", "Provide mediaId or path");
}

function referencedMediaIds(ctx: ToolContext): Set<string> {
  const used = new Set<string>();
  for (const el of Object.values(ctx.host.project.elements)) if ("mediaId" in el) used.add(el.mediaId);
  return used;
}

export const timelineTools = [
  defineTool({
    name: "relinkMedia",
    title: "Locate missing media",
    category: "timeline",
    description: "Reconnect the original file to an existing media asset, keeping clips, trims and transcripts.",
    input: z.object({ mediaId: z.string(), path: z.string().min(1), projectId: z.string().optional(), expectedVersion }),
    handler: async (a, ctx) => {
      if (a.projectId !== undefined && a.projectId !== ctx.host.projectId) {
        throw new EditError("VERSION_CONFLICT", "Reopen the project before locating its media.");
      }
      const result = await ctx.host.relinkMedia(a.mediaId, a.path, ctx.source, a.expectedVersion);
      return { ok: true, mediaId: a.mediaId, version: result.version };
    },
  }),
  defineTool({
    name: "importToMediaPanel",
    title: "Import to media panel",
    category: "timeline",
    description: "Import files into the project's media panel without placing them (probes duration, size, fps, codecs). Re-importing a path returns the existing media id.",
    input: z.object({ paths: z.array(z.string()).min(1), folderId: z.string().optional() }),
    handler: async (a, ctx) => {
      const r = await ctx.host.importMedia(a.paths, { folderId: a.folderId, source: ctx.source });
      return { ok: true, version: ctx.host.session.version, media: r.assets, addedIds: r.added, existingIds: r.existing };
    },
  }),
  defineTool({
    name: "mediaPanel",
    title: "Media panel",
    category: "timeline",
    description: "List imported media with the media-bin filters (all/video/audio/images, unreferencedOnly, folder) and sorting.",
    input: z.object({
      filter: z.enum(["all", "video", "audio", "images"]).optional(),
      unreferencedOnly: z.boolean().optional(),
      folderId: z.string().optional(),
      sort: z.enum(["name", "date_imported", "date_created", "type", "duration"]).optional(),
      ...pageInput,
    }),
    readOnly: true,
    handler: (a, ctx) => {
      const used = referencedMediaIds(ctx);
      const kind = { all: undefined, video: "video", audio: "audio", images: "image" }[a.filter ?? "all"];
      const items = Object.values(ctx.host.project.media)
        .filter((m) => (!kind || m.kind === kind) && (!a.unreferencedOnly || !used.has(m.id)) && (!a.folderId || m.folderId === a.folderId))
        .sort((x, y) => {
          switch (a.sort ?? "date_imported") {
            case "name":
              return x.name.localeCompare(y.name);
            case "date_created":
              return (x.createdAt ?? 0) - (y.createdAt ?? 0);
            case "type":
              return x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name);
            case "duration":
              return (x.durationSourceSeconds ?? 0) - (y.durationSourceSeconds ?? 0);
            default:
              return x.importedAt - y.importedAt;
          }
        })
        .map((m) => ({ ...m, referenced: used.has(m.id) }));
      return { folders: ctx.host.project.mediaFolders, ...paginate(items, a.offset, a.limit) };
    },
  }),
  defineTool({
    name: "createMediaFolder",
    title: "Create media folder",
    category: "timeline",
    description: "Create a folder in the media panel hierarchy.",
    input: z.object({ name: z.string().min(1), parentId: z.string().optional(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Create media folder", (c) => addMediaFolder(c, a.name, a.parentId), { expectedVersion: a.expectedVersion, skipFinalize: true }, (f) => ({ folder: f })),
  }),
  defineTool({
    name: "addMediaPanelItemsToTimeline",
    title: "Add media panel items to timeline",
    category: "timeline",
    description: "Place imported media on the timeline in order. Video/images go on the main track (appended, at index, or inserted at atTime); audio goes on a music lane. asOverlay places visuals on overlay lanes at atTime.",
    input: z.object({
      mediaIds: z.array(z.string()).min(1),
      atTime: z.number().min(0).optional(),
      index: z.number().int().min(0).optional(),
      asOverlay: z.boolean().optional(),
      expectedVersion,
    }),
    handler: (a, ctx) =>
      mutate(ctx, `Add ${a.mediaIds.length} item${a.mediaIds.length > 1 ? "s" : ""} to timeline`, (c) => {
        const ids: string[] = [];
        let cursor = a.atTime;
        let index = a.index;
        for (const mid of a.mediaIds) {
          const el = addMediaToTimeline(c, requireMedia(c.draft, mid), { start: cursor, index, asOverlay: a.asOverlay });
          ids.push(el.id);
          if (index !== undefined) index++;
          if (cursor !== undefined) cursor += el.duration;
        }
        return ids;
      }, { expectedVersion: a.expectedVersion }, (ids) => ({ elementIds: ids })),
  }),
  defineTool({
    name: "addMedia",
    title: "Add media",
    category: "timeline",
    description: "Import (by path) or reuse (by mediaId) a media file and add it to the timeline. Video/images default to the main track; audio to a lane chosen by role (music, sfx, voiceover).",
    input: z.object({
      path: z.string().optional(),
      mediaId: z.string().optional(),
      start: z.number().min(0).optional().describe("Timeline time; on the main track a time inside a clip splits it and inserts there"),
      index: z.number().int().min(0).optional().describe("Main-track position"),
      asOverlay: z.boolean().optional(),
      trackId: z.string().optional(),
      role: z.enum(["music", "sfx", "voiceover"]).optional(),
      sourceInSourceSeconds: z.number().min(0).optional(),
      sourceDurationSourceSeconds: z.number().positive().optional(),
      durationSeconds: z.number().positive().optional().describe("Image duration, or a cap for video/audio"),
      transform: transformInput.optional(),
      expectedVersion,
    }),
    handler: async (a, ctx) => {
      const media = await mediaFrom(ctx, a);
      return mutate(ctx, `Add ${media.name}`, (c) => addMediaToTimeline(c, c.draft.media[media.id], { ...a, transform: a.transform }), { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id, mediaId: media.id }));
    },
  }),
  defineTool({
    name: "addOverlay",
    title: "Add overlay",
    category: "timeline",
    description: "Add a video or image as an overlay (B-roll / picture-in-picture) on a free lane at `start`. Default transform: contain at 0.6 scale, centered.",
    input: z.object({
      path: z.string().optional(),
      mediaId: z.string().optional(),
      start: z.number().min(0),
      durationSeconds: z.number().positive().optional(),
      sourceInSourceSeconds: z.number().min(0).optional(),
      transform: transformInput.optional(),
      trackId: z.string().optional(),
      expectedVersion,
    }),
    handler: async (a, ctx) => {
      const media = await mediaFrom(ctx, a);
      if (media.kind === "audio") throw new EditError("UNSUPPORTED_MEDIA", "Overlays must be video or images; use addMedia for audio");
      return mutate(ctx, `Add overlay ${media.name}`, (c) => addMediaToTimeline(c, c.draft.media[media.id], { ...a, asOverlay: true }), { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id, trackId: ctx.host.project.elements[el.id].trackId }));
    },
  }),
  defineTool({
    name: "addAdjustmentLayer",
    title: "Add adjustment layer",
    category: "timeline",
    description: "Add an adjustment layer that grades everything below it over [start, start+duration). Optionally set a filter, LUT or grade in the same step.",
    input: z.object({
      start: z.number().min(0),
      duration: z.number().positive(),
      name: z.string().optional(),
      filterId: z.string().optional(),
      lutId: z.string().optional(),
      grade: ColorGradeSchema.partial().optional().describe("Partial color grade, e.g. {contrast: 20}"),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      if (a.filterId) assertCatalogId("filters", a.filterId);
      if (a.lutId) assertCatalogId("luts", a.lutId);
      return mutate(ctx, "Add adjustment layer", (c) => {
        const el = addAdjustmentLayer(c, a);
        if (a.filterId) applyFilter(c, el, a.filterId, 100);
        if (a.lutId) applyLut(c, el, { id: a.lutId, intensity: 100 });
        if (a.grade) setColorGrade(c, el, a.grade);
        return el;
      }, { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id }));
    },
  }),
  defineTool({
    name: "addShape",
    title: "Add shape",
    category: "timeline",
    description: "Add a rectangle, ellipse, line or gradient scrim. widthNorm/heightNorm are fractions of canvas width/height.",
    input: z.object({
      shape: z.enum(["rectangle", "ellipse", "line", "scrim"]),
      start: z.number().min(0),
      duration: z.number().positive(),
      widthNorm: z.number().positive().max(4).optional(),
      heightNorm: z.number().positive().max(4).optional(),
      fillColor: hexColor.optional(),
      gradientToColor: hexColor.optional(),
      strokeColor: hexColor.optional(),
      strokeWidth: z.number().min(0).max(0.2).optional(),
      cornerRadius: z.number().min(0).max(1).optional(),
      opacity: z.number().min(0).max(1).optional(),
      transform: transformInput.optional(),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      const def = findCatalogItem("shapes", a.shape)?.data as { defaultSize: { widthNorm: number; heightNorm: number } } | undefined;
      return mutate(ctx, `Add ${a.shape}`, (c) =>
        addShape(c, {
          ...a,
          widthNorm: a.widthNorm ?? def?.defaultSize.widthNorm ?? 0.5,
          heightNorm: a.heightNorm ?? def?.defaultSize.heightNorm ?? 0.2,
          fillColor: a.fillColor ?? (a.shape === "scrim" ? "#00000000" : "#FFFFFF"),
          ...(a.shape === "scrim" && !a.gradientToColor ? { gradientToColor: "#000000B3" } : {}),
        }), { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id }));
    },
  }),
  defineTool({
    name: "addText",
    title: "Add text",
    category: "timeline",
    description: "Add a text element. Optionally start from a text preset (listCatalog kind textPresets) and/or override style fields.",
    input: z.object({
      text: z.string().min(1),
      start: z.number().min(0),
      duration: z.number().positive(),
      presetId: z.string().optional(),
      style: TextStyleSchema.partial().optional().describe("Partial TextStyle (fontFamily, fontWeight, fontSizeNorm, color, strokeColor, backgroundColor, align, ...)"),
      transform: transformInput.optional(),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      const preset = a.presetId ? (getCatalogItem("textPresets", a.presetId).data as { style: Partial<TextStyle> }).style : {};
      const style: Partial<TextStyle> = { ...preset, ...a.style };
      return mutate(ctx, "Add text", (c) => addText(c, { ...a, style }), { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id, trackId: ctx.host.project.elements[el.id].trackId }));
    },
  }),
  defineTool({
    name: "addSticker",
    title: "Add sticker",
    category: "timeline",
    description: "Add a vector sticker from the catalog (listCatalog kind stickers).",
    input: z.object({ stickerId: z.string(), start: z.number().min(0), duration: z.number().positive(), transform: transformInput.optional(), expectedVersion }),
    handler: (a, ctx) => {
      assertCatalogId("stickers", a.stickerId);
      return mutate(ctx, "Add sticker", (c) => addSticker(c, a), { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id }));
    },
  }),
  defineTool({
    name: "addTransition",
    title: "Add transition",
    category: "timeline",
    description: "Add/replace the transition at the cut after a main-track clip. Centered on the cut and never longer than the shorter clip; where a clip has no spare footage past the cut its edge frame is held. type \"none\" removes it.",
    input: z.object({ fromElementId: z.string(), type: z.string(), durationSeconds: z.number().positive().max(5).optional(), expectedVersion }),
    handler: (a, ctx) => {
      const item = findCatalogItem("transitions", a.type);
      if (!item) assertCatalogId("transitions", a.type);
      const dur = a.durationSeconds ?? (item!.data as { defaultDurationSeconds: number }).defaultDurationSeconds ?? 0.5;
      return mutate(ctx, a.type === "none" ? "Remove transition" : `Add ${item!.name} transition`, (c) => addTransition(c, { fromElementId: a.fromElementId, type: a.type, durationSeconds: dur || 0.5 }), { expectedVersion: a.expectedVersion }, (tr) => ({ transition: tr }));
    },
  }),
  defineTool({
    name: "split",
    title: "Split",
    category: "timeline",
    description: "Split one element at a timeline time (default: the playhead). The left part keeps the id; the right part's id is returned.",
    input: z.object({ elementId: z.string().optional(), time: z.number().min(0).optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      const t = a.time ?? ctx.host.appState.playheadSeconds;
      return mutate(ctx, "Split", (c) => {
        const r = splitElement(c, requireElement(c.draft, id), t);
        if (!r) throw new EditError("INVALID_RANGE", `Cannot split ${id} at ${t}s (outside the element or within one frame of an edge)`);
        return r.id;
      }, { expectedVersion: a.expectedVersion }, (rightId) => ({ leftId: id, rightId }));
    },
  }),
  defineTool({
    name: "splitAt",
    title: "Split at many times",
    category: "timeline",
    description: "Split at up to 1,000 timeline times in one undo step. Default scope: main track. snap: projectFrame (default), sourceFrameCeil or none.",
    input: z.object({
      times: z.array(z.number().min(0)).min(1).max(1000),
      snap: z.enum(["projectFrame", "sourceFrameCeil", "none"]).optional(),
      elementIds: z.array(z.string()).optional(),
      trackIds: z.array(z.string()).optional(),
      allTracks: z.boolean().optional(),
      expectedVersion,
    }),
    handler: (a, ctx) => mutate(ctx, `Split at ${a.times.length} time${a.times.length > 1 ? "s" : ""}`, (c) => splitAt(c, a), { expectedVersion: a.expectedVersion }, (r) => ({ splits: r.splits, skipped: r.skipped })),
  }),
  defineTool({
    name: "trim",
    title: "Trim",
    category: "timeline",
    description: "Trim an element edge by deltaSeconds: positive shortens, negative extends (clamped to source media). Main-track trims ripple downstream clips.",
    input: z.object({ elementId: z.string().optional(), side: z.enum(["left", "right"]), deltaSeconds: z.number(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `Trim ${a.side}`, (c) => trimElement(c, requireElement(c.draft, id), a.side, a.deltaSeconds), { expectedVersion: a.expectedVersion }, (removed) => ({ removedSeconds: round(removed), element: ctx.host.project.elements[id] && { start: ctx.host.project.elements[id].start, duration: ctx.host.project.elements[id].duration } }));
    },
  }),
  defineTool({
    name: "trimStart",
    title: "Trim start",
    category: "timeline",
    description: "Trim the head so content begins at timeline time `time` (removes [start, time)).",
    input: z.object({ elementId: z.string().optional(), time: z.number().min(0), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Trim start", (c) => trimStartTo(c, requireElement(c.draft, id), a.time), { expectedVersion: a.expectedVersion }, (removed) => ({ removedSeconds: round(removed) }));
    },
  }),
  defineTool({
    name: "trimEnd",
    title: "Trim end",
    category: "timeline",
    description: "Trim (or extend) the tail so the element ends at timeline time `time`.",
    input: z.object({ elementId: z.string().optional(), time: z.number().min(0), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Trim end", (c) => trimEndTo(c, requireElement(c.draft, id), a.time), { expectedVersion: a.expectedVersion }, (removed) => ({ removedSeconds: round(removed) }));
    },
  }),
  defineTool({
    name: "slipClip",
    title: "Slip clip",
    category: "timeline",
    description: "Shift which part of the source plays without moving the clip on the timeline (deltaSourceSeconds; clamped to the media).",
    input: z.object({ elementId: z.string().optional(), deltaSourceSeconds: z.number(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Slip", (c) => slipElement(c, requireElement(c.draft, id), a.deltaSourceSeconds), { expectedVersion: a.expectedVersion }, (d) => ({ appliedDeltaSourceSeconds: round(d) }));
    },
  }),
  defineTool({
    name: "move",
    title: "Move",
    category: "timeline",
    description: "Move an element to a new start time and/or track. Main-track clips are reordered to the slot at `start`. Snaps to edges/markers/beats when snapping is on (override with snap).",
    input: z.object({ elementId: z.string().optional(), start: z.number().min(0).optional(), trackId: z.string().optional(), snap: z.boolean().optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Move", (c) => moveElement(c, requireElement(c.draft, id), { ...a, playheadSeconds: ctx.host.appState.playheadSeconds }), { expectedVersion: a.expectedVersion }, (r) => ({ snapped: r.snapped, start: ctx.host.project.elements[id]?.start, trackId: ctx.host.project.elements[id]?.trackId }));
    },
  }),
  defineTool({
    name: "moveToLayer",
    title: "Move to layer",
    category: "timeline",
    description: "Move a free-track element to another lane: a specific trackId, or direction up/down/top/bottom in the stack.",
    input: z.object({ elementId: z.string().optional(), trackId: z.string().optional(), direction: z.enum(["up", "down", "top", "bottom"]).optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Move to layer", (c) => moveToLayer(c, requireElement(c.draft, id), a).id, { expectedVersion: a.expectedVersion }, () => ({ trackId: ctx.host.project.elements[id].trackId, trackIndex: ctx.host.project.tracks.findIndex((t) => t.id === ctx.host.project.elements[id].trackId) }));
    },
  }),
  defineTool({
    name: "reorderClip",
    title: "Reorder clip",
    category: "timeline",
    description: "Move a main-track clip to a new index; the magnetic track re-flows.",
    input: z.object({ elementId: z.string().optional(), toIndex: z.number().int().min(0), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Reorder clip", (c) => reorderMain(c, requireElement(c.draft, id), a.toIndex), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "convertToOverlay",
    title: "Convert to overlay",
    category: "timeline",
    description: "Move a main-track clip to an overlay lane at the same time (or `start`); the main track closes the gap.",
    input: z.object({ elementId: z.string().optional(), start: z.number().min(0).optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Convert to overlay", (c) => convertToOverlay(c, requireElement(c.draft, id), { start: a.start }), { expectedVersion: a.expectedVersion }, () => ({ trackId: ctx.host.project.elements[id].trackId }));
    },
  }),
  defineTool({
    name: "convertToMain",
    title: "Convert to main",
    category: "timeline",
    description: "Move an overlay video/image onto the main track (at index, or the slot nearest its start). Its transform resets to full-frame cover.",
    input: z.object({ elementId: z.string().optional(), index: z.number().int().min(0).optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Convert to main", (c) => convertToMain(c, requireElement(c.draft, id), { index: a.index }), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "duplicate",
    title: "Duplicate",
    category: "timeline",
    description: "Duplicate an element (main clips: inserted right after; others: placed after the original).",
    input: z.object({ elementId: z.string().optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Duplicate", (c) => duplicateElement(c, requireElement(c.draft, id)).id, { expectedVersion: a.expectedVersion }, (newId) => ({ elementId: newId }));
    },
  }),
  defineTool({
    name: "delete",
    title: "Delete",
    category: "timeline",
    description: "Delete elements (default: the selection). Main-track deletions ripple when the magnet is on. Undoable.",
    input: z.object({ elementIds: z.array(z.string()).optional(), expectedVersion }),
    destructive: true,
    handler: (a, ctx) => {
      const ids = a.elementIds ?? ctx.host.appState.selection.elementIds;
      if (!ids.length) throw new EditError("INVALID_ARGUMENT", "elementIds is required (nothing is selected)");
      return mutate(ctx, `Delete ${ids.length} element${ids.length > 1 ? "s" : ""}`, (c) => deleteElements(c, ids), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "extractAudio",
    title: "Extract audio",
    category: "timeline",
    description: "Detach a video's audio into a linked audio element on an audio lane (the video's own audio is muted).",
    input: z.object({ elementId: z.string().optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Extract audio", (c) => extractAudio(c, requireElement(c.draft, id)).id, { expectedVersion: a.expectedVersion }, (audioId) => ({ audioElementId: audioId }));
    },
  }),
  defineTool({
    name: "replaceElementMedia",
    title: "Replace media",
    category: "timeline",
    description: "Swap the media under an element (drag-to-replace), keeping its timeline slot, transform, color and effects.",
    input: z.object({ elementId: z.string().optional(), mediaId: z.string().optional(), path: z.string().optional(), expectedVersion }),
    handler: async (a, ctx) => {
      const id = element(ctx, a.elementId).id;
      const media = await mediaFrom(ctx, a);
      return mutate(ctx, `Replace media with ${media.name}`, (c) => replaceElementMedia(c, requireElement(c.draft, id), c.draft.media[media.id]), { expectedVersion: a.expectedVersion }, () => ({ mediaId: media.id }));
    },
  }),
];
