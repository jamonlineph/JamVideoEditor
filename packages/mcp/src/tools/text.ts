import { z } from "zod";
import {
  EditError,
  TEXT_POSITIONS,
  TextStyleSchema,
  addCaptions,
  captionText,
  editCaption,
  editText,
  getCatalogItem,
  mergeCaptions,
  setCaptionHighlightColor,
  setCaptionHighlights,
  setCaptionStyle,
  setEmphasis,
  setTeleprompter,
  setTextAnimation,
  setTextPosition,
  setTextStyle,
  splitCaption,
  type CaptionElement,
  type TextStyle,
} from "@openedits/core";
import { defineTool } from "../defineTool.js";
import { expectedVersion, hexColor, inRange, mutate, pageInput, paginate, rangeInput, resolveElementId, round } from "./common.js";

const animRef = z.object({ id: z.string(), durationSeconds: z.number().positive().max(10).optional() });

function animation(slot: "in" | "out" | "loop", ref?: { id: string; durationSeconds?: number }) {
  if (!ref) return undefined;
  if (ref.id === "none") return { id: "none", durationSeconds: 0.4 };
  const item = getCatalogItem("textAnimations", ref.id);
  const data = item.data as { slot: string; defaultDurationSeconds: number };
  if (data.slot !== slot) throw new EditError("INVALID_ARGUMENT", `Animation "${ref.id}" is a ${data.slot} animation, not ${slot}`);
  return { id: ref.id, durationSeconds: ref.durationSeconds ?? data.defaultDurationSeconds };
}

function captionIds(ctx: { host: { project: { elements: Record<string, { type: string }> } } }, ids?: string[]) {
  if (ids?.length) return ids;
  return Object.values(ctx.host.project.elements)
    .filter((e) => e.type === "caption")
    .map((e) => (e as CaptionElement).id);
}

export const textTools = [
  defineTool({
    name: "editText",
    title: "Edit text",
    category: "text",
    description: "Replace the text content of a text element.",
    input: z.object({ elementId: z.string().optional(), text: z.string().min(1), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Edit text", (c) => editText(c, id, a.text), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "setTextFont",
    title: "Set font",
    category: "text",
    description: "Set the font family (listCatalog kind fonts, or any installed family) and optional weight/italic of a text or caption element.",
    input: z.object({ elementId: z.string().optional(), fontFamily: z.string().min(1), fontWeight: z.number().int().min(100).max(1000).optional(), italic: z.boolean().optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...patch }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, `Font ${patch.fontFamily}`, (c) => setTextStyle(c, id, patch), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setTextStyle",
    title: "Set text style",
    category: "text",
    description: "Change style fields of a text element (or caption overrides): fontSizeNorm (fraction of canvas short side), color, strokeColor/strokeWidth, shadow*, backgroundColor/backgroundPadding/backgroundCornerRadius, align, lineHeight, letterSpacing, uppercase, underline, maxWidthNorm.",
    input: TextStyleSchema.partial().extend({ elementId: z.string().optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...patch }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Text style", (c) => setTextStyle(c, id, patch as Partial<TextStyle>), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setTextPosition",
    title: "Set text position",
    category: "text",
    description: `Position a text/caption element by normalized center (x, y) or a preset: ${Object.keys(TEXT_POSITIONS).join(", ")}.`,
    input: z.object({ elementId: z.string().optional(), x: z.number().optional(), y: z.number().optional(), preset: z.enum(Object.keys(TEXT_POSITIONS) as [string, ...string[]]).optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...pos }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Text position", (c) => setTextPosition(c, id, pos), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setEmphasis",
    title: "Set emphasis",
    category: "text",
    description: "Emphasize character ranges [startChar, endChar) of a text element with color, weight, scale or background. Replaces existing emphasis; pass [] to clear.",
    input: z.object({
      elementId: z.string().optional(),
      ranges: z.array(z.object({ startChar: z.number().int().min(0), endChar: z.number().int().min(1), color: hexColor.optional(), fontWeight: z.number().int().min(100).max(1000).optional(), scale: z.number().positive().max(4).optional(), backgroundColor: hexColor.optional() })),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Emphasis", (c) => setEmphasis(c, id, a.ranges), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "applyTextPreset",
    title: "Apply text preset",
    category: "text",
    description: "Apply one of the 34 text presets (listCatalog kind textPresets) to a text element.",
    input: z.object({ elementId: z.string().optional(), presetId: z.string(), expectedVersion }),
    handler: (a, ctx) => {
      const item = getCatalogItem("textPresets", a.presetId);
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `Text preset ${item.name}`, (c) => {
        const el = c.draft.elements[id];
        if (!el || el.type !== "text") throw new EditError("INVALID_ELEMENT_TYPE", `${id} is not a text element`);
        setTextStyle(c, id, (item.data as { style: Partial<TextStyle> }).style);
        el.presetId = a.presetId;
      }, { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "setTextAnimation",
    title: "Set text animation",
    category: "text",
    description: "Set in / out / loop animations (listCatalog kind textAnimations); id \"none\" clears a slot.",
    input: z.object({ elementId: z.string().optional(), in: animRef.optional(), out: animRef.optional(), loop: animRef.optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      const anim = { in: animation("in", a.in), out: animation("out", a.out), loop: animation("loop", a.loop) };
      for (const k of ["in", "out", "loop"] as const) if (!anim[k]) delete anim[k];
      return mutate(ctx, "Text animation", (c) => setTextAnimation(c, id, anim), { expectedVersion: a.expectedVersion });
    },
  }),
  // ------------------------------------------------------------ captions
  defineTool({
    name: "addCaptions",
    title: "Add captions",
    category: "text",
    description: "Add caption segments manually (e.g. from an SRT). Word times are timeline seconds. generateCaptions (Phase 4) builds these from a transcript.",
    input: z.object({
      segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), words: z.array(z.object({ text: z.string(), start: z.number().min(0), end: z.number().min(0), id: z.union([z.number(), z.string()]).optional() })).min(1) })).min(1),
      styleId: z.string().optional(),
      highlightColor: hexColor.optional(),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      const style = getCatalogItem("captionStyles", a.styleId ?? ctx.host.settings.defaultCaptionStyle);
      const hl = a.highlightColor ?? (style.data as { highlightColor: string }).highlightColor;
      return mutate(ctx, `Add ${a.segments.length} caption${a.segments.length > 1 ? "s" : ""}`, (c) => addCaptions(c, a.segments, { styleId: style.id, highlightColor: hl }).map((e) => e.id), { expectedVersion: a.expectedVersion }, (ids) => ({ elementIds: ids }));
    },
  }),
  defineTool({
    name: "captions",
    title: "List captions",
    category: "text",
    description: "Caption segments with their words (ids, timeline times, highlight flags), filtered by time range.",
    input: z.object({ ...rangeInput, ...pageInput }),
    readOnly: true,
    handler: (a, ctx) => {
      const items = Object.values(ctx.host.project.elements)
        .filter((e): e is CaptionElement => e.type === "caption")
        .filter((e) => inRange(e, a.from, a.to))
        .sort((x, y) => x.start - y.start)
        .map((e) => ({
          elementId: e.id,
          start: round(e.start),
          end: round(e.start + e.duration),
          text: captionText(e),
          styleId: e.styleId,
          highlightColor: e.highlightColor,
          words: e.words.map((w) => ({ id: w.id, text: w.text, start: round(e.start + w.startOffsetSeconds), end: round(e.start + w.endOffsetSeconds), highlighted: w.highlighted })),
        }));
      return paginate(items, a.offset, a.limit);
    },
  }),
  defineTool({
    name: "editCaption",
    title: "Edit caption",
    category: "text",
    description: "Fix a single caption word (wordId) or replace a whole segment's text (words re-timed evenly if the count changes).",
    input: z.object({ elementId: z.string(), text: z.string().min(1), wordId: z.union([z.number(), z.string()]).optional(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Edit caption", (c) => editCaption(c, a.elementId, a), { expectedVersion: a.expectedVersion }),
  }),
  defineTool({
    name: "splitCaption",
    title: "Split caption",
    category: "text",
    description: "Split a caption segment before the given word id.",
    input: z.object({ elementId: z.string(), beforeWordId: z.union([z.number(), z.string()]), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Split caption", (c) => splitCaption(c, a.elementId, a.beforeWordId).id, { expectedVersion: a.expectedVersion }, (id) => ({ newElementId: id })),
  }),
  defineTool({
    name: "mergeCaptions",
    title: "Merge captions",
    category: "text",
    description: "Merge caption segments into the earliest one.",
    input: z.object({ elementIds: z.array(z.string()).min(2), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Merge captions", (c) => mergeCaptions(c, a.elementIds).id, { expectedVersion: a.expectedVersion }, (id) => ({ elementId: id })),
  }),
  defineTool({
    name: "setCaptionStyle",
    title: "Set caption style",
    category: "text",
    description: "Apply one of the 39 caption styles (listCatalog kind captionStyles) to captions (default: all), with optional style overrides.",
    input: z.object({ styleId: z.string(), elementIds: z.array(z.string()).optional(), overrides: TextStyleSchema.partial().optional(), expectedVersion }),
    handler: (a, ctx) => {
      const style = getCatalogItem("captionStyles", a.styleId);
      const ids = captionIds(ctx, a.elementIds);
      if (!ids.length) throw new EditError("INVALID_ARGUMENT", "There are no captions to style");
      return mutate(ctx, `Caption style ${style.name}`, (c) => setCaptionStyle(c, ids, a.styleId, a.overrides as Partial<TextStyle> | undefined), { expectedVersion: a.expectedVersion }, () => ({ styled: ids.length }));
    },
  }),
  defineTool({
    name: "setCaptionHighlights",
    title: "Set caption highlights",
    category: "text",
    description: "Mark caption words (by word id) as highlighted keywords, or clear them.",
    input: z.object({ elementId: z.string(), wordIds: z.array(z.union([z.number(), z.string()])).min(1), highlighted: z.boolean().optional(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Caption highlights", (c) => setCaptionHighlights(c, a.elementId, a.wordIds, a.highlighted ?? true), { expectedVersion: a.expectedVersion }),
  }),
  defineTool({
    name: "setCaptionHighlightColor",
    title: "Set caption highlight color",
    category: "text",
    description: "Set the active-word / keyword highlight color for captions (default: all).",
    input: z.object({ color: hexColor, elementIds: z.array(z.string()).optional(), expectedVersion }),
    handler: (a, ctx) => {
      const ids = captionIds(ctx, a.elementIds);
      if (!ids.length) throw new EditError("INVALID_ARGUMENT", "There are no captions");
      return mutate(ctx, "Caption highlight color", (c) => setCaptionHighlightColor(c, ids, a.color), { expectedVersion: a.expectedVersion });
    },
  }),
  // ------------------------------------------------------------ teleprompter
  defineTool({
    name: "openTeleprompter",
    title: "Open teleprompter",
    category: "text",
    description: "Show or hide the teleprompter overlay, optionally setting fontSize and scrollSpeed (words per minute). Script and settings persist with the project.",
    input: z.object({ open: z.boolean().optional(), fontSize: z.number().min(8).max(200).optional(), scrollSpeed: z.number().min(20).max(400).optional() }),
    handler: (a, ctx) => {
      const patch = { ...(a.fontSize !== undefined ? { fontSize: a.fontSize } : {}), ...(a.scrollSpeed !== undefined ? { scrollSpeed: a.scrollSpeed } : {}) };
      const res = Object.keys(patch).length ? mutate(ctx, "Teleprompter settings", (c) => setTeleprompter(c, patch), { skipFinalize: true }) : { ok: true };
      ctx.host.setAppState({ teleprompterOpen: a.open ?? true });
      return { ...res, teleprompterOpen: ctx.host.appState.teleprompterOpen, teleprompter: ctx.host.project.teleprompter };
    },
  }),
  defineTool({
    name: "setTeleprompterText",
    title: "Set teleprompter text",
    category: "text",
    description: "Replace the teleprompter script for this project.",
    input: z.object({ text: z.string(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Teleprompter script", (c) => setTeleprompter(c, { text: a.text }), { expectedVersion: a.expectedVersion, skipFinalize: true }, () => ({ words: a.text.split(/\s+/).filter(Boolean).length })),
  }),
];

