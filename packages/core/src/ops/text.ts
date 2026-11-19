import type {
  AdjustmentElement,
  CaptionElement,
  CaptionWord,
  Element,
  ShapeElement,
  StickerElement,
  TextElement,
  TextStyle,
  Transform,
} from "../schema.js";
import { TextStyleSchema } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import { defaultColor, defaultMask, defaultTextStyle, defaultTransform, defaultVisualProps } from "../defaults.js";
import { assertUnlocked, requireElement, requireElementOfType } from "../timeline/query.js";
import { attachToTrack, findOrCreateLane } from "../timeline/tracks.js";
import type { EditContext } from "./context.js";
import { placeFreeElement } from "./arrange.js";
import { plainClone } from "./elements.js";
import { CAPTION_STYLES, TEXT_PRESETS } from "../catalog/text.js";

export interface AddTextOptions {
  text: string;
  start: number;
  duration: number;
  style?: Partial<TextStyle>;
  presetId?: string;
  transform?: Partial<Transform>;
  trackId?: string;
}

export function addText(ctx: EditContext, opts: AddTextOptions): TextElement {
  if (opts.duration <= 0) throw new EditError("INVALID_RANGE", "duration must be > 0");
  const el: TextElement = {
    type: "text",
    id: ctx.ids("el"),
    trackId: "",
    name: opts.text.slice(0, 40),
    start: cleanTime(Math.max(0, opts.start)),
    duration: cleanTime(opts.duration),
    ...defaultVisualProps({ fit: "contain", ...opts.transform }),
    text: opts.text,
    style: defaultTextStyle(opts.style),
    ...(opts.presetId ? { presetId: opts.presetId } : {}),
    animation: {},
    emphasis: [],
  };
  placeFreeElement(ctx, el, opts.trackId);
  return el;
}

function requireText(ctx: EditContext, id: string): TextElement {
  const el = requireElementOfType(ctx.draft, id, ["text"] as const);
  assertUnlocked(ctx.draft, el);
  return el;
}

export function editText(ctx: EditContext, id: string, text: string) {
  const el = requireText(ctx, id);
  el.text = text;
  el.name = text.slice(0, 40);
  el.emphasis = el.emphasis.filter((e) => e.endChar <= text.length);
  ctx.touch(id);
}

/** Merge a partial style into a text element (or caption overrides). */
export function setTextStyle(ctx: EditContext, id: string, patch: Partial<TextStyle>) {
  const el = requireElement(ctx.draft, id);
  assertUnlocked(ctx.draft, el);
  if (el.type === "text") {
    el.style = TextStyleSchema.parse({ ...el.style, ...patch });
  } else if (el.type === "caption") {
    el.styleOverrides = { ...el.styleOverrides, ...patch };
  } else throw new EditError("INVALID_ELEMENT_TYPE", `Element ${id} (${el.type}) has no text style`);
  ctx.touch(id);
}

/** Restore a title or caption to its current preset, or to the default text style. */
export function resetTextStyle(ctx: EditContext, id: string) {
  const el = requireElement(ctx.draft, id);
  assertUnlocked(ctx.draft, el);
  if (el.type === "text") {
    el.style = defaultTextStyle(TEXT_PRESETS.find((preset) => preset.id === el.presetId)?.data.style);
  } else if (el.type === "caption") {
    el.styleOverrides = {};
    const preset = CAPTION_STYLES.find((style) => style.id === el.styleId);
    if (preset) el.highlightColor = preset.data.highlightColor;
  } else throw new EditError("INVALID_ELEMENT_TYPE", `Element ${id} (${el.type}) has no text style`);
  ctx.touch(id);
}

export const TEXT_POSITIONS: Record<string, { x: number; y: number }> = {
  top: { x: 0.5, y: 0.15 },
  upperThird: { x: 0.5, y: 0.33 },
  center: { x: 0.5, y: 0.5 },
  lowerThird: { x: 0.5, y: 0.7 },
  bottom: { x: 0.5, y: 0.85 },
  topLeft: { x: 0.25, y: 0.15 },
  topRight: { x: 0.75, y: 0.15 },
  bottomLeft: { x: 0.25, y: 0.85 },
  bottomRight: { x: 0.75, y: 0.85 },
};

export function setTextAnimation(ctx: EditContext, id: string, anim: TextElement["animation"]) {
  const el = requireText(ctx, id);
  el.animation = { ...el.animation, ...anim };
  for (const k of ["in", "out", "loop"] as const) if (anim[k] && anim[k]!.id === "none") delete el.animation[k];
  ctx.touch(id);
}

export function setEmphasis(ctx: EditContext, id: string, ranges: TextElement["emphasis"]) {
  const el = requireText(ctx, id);
  for (const r of ranges) {
    if (r.endChar <= r.startChar || r.endChar > el.text.length) throw new EditError("INVALID_RANGE", `Emphasis range ${r.startChar}-${r.endChar} is outside the text (length ${el.text.length})`);
  }
  el.emphasis = ranges;
  ctx.touch(id);
}

// ---------------------------------------------------------------- captions

export interface CaptionSegmentInput {
  start: number;
  end: number;
  words: { text: string; start: number; end: number; id?: number | string }[];
}

/** Add caption segments (manual or imported). Word times are timeline seconds. */
export function addCaptions(
  ctx: EditContext,
  segments: CaptionSegmentInput[],
  opts: { styleId: string; highlightColor: string; styleOverrides?: Partial<TextStyle>; sourceMediaId?: string },
): CaptionElement[] {
  const out: CaptionElement[] = [];
  let lane: ReturnType<typeof findOrCreateLane> | undefined;
  for (const seg of segments) {
    if (seg.end <= seg.start + EPS) throw new EditError("INVALID_RANGE", `Caption segment end ${seg.end} must be after start ${seg.start}`);
    if (seg.words.length === 0) throw new EditError("INVALID_ARGUMENT", "Caption segments need at least one word");
    const words: CaptionWord[] = seg.words.map((w, i) => ({
      id: w.id ?? `w${i + 1}`,
      text: w.text,
      startOffsetSeconds: cleanTime(Math.max(0, w.start - seg.start)),
      endOffsetSeconds: cleanTime(Math.min(seg.end, Math.max(w.end, w.start)) - seg.start),
      highlighted: false,
    }));
    const el: CaptionElement = {
      type: "caption",
      id: ctx.ids("el"),
      trackId: "",
      start: cleanTime(seg.start),
      duration: cleanTime(seg.end - seg.start),
      ...defaultVisualProps({ fit: "contain", y: 0.72 }),
      words,
      styleId: opts.styleId,
      styleOverrides: opts.styleOverrides ?? {},
      highlightColor: opts.highlightColor.toUpperCase(),
      ...(opts.sourceMediaId ? { sourceMediaId: opts.sourceMediaId } : {}),
    };
    ctx.draft.elements[el.id] = el;
    // Keep all segments of one call on the same lane when possible.
    lane = findOrCreateLane(ctx, "caption", el.start, el.start + el.duration, { preferTrackId: lane?.id, excludeId: el.id });
    attachToTrack(ctx.draft, el, lane);
    ctx.positioned.add(el.id);
    ctx.touch(el.id);
    ctx.created.push(el.id);
    out.push(el);
  }
  return out;
}

function requireCaption(ctx: EditContext, id: string): CaptionElement {
  const el = requireElementOfType(ctx.draft, id, ["caption"] as const);
  assertUnlocked(ctx.draft, el);
  return el;
}

export function captionText(el: CaptionElement): string {
  return el.words.map((w) => w.text).join(" ");
}

/** Edit one word (by id) or replace a whole segment's text (re-timing words evenly). */
export function editCaption(ctx: EditContext, id: string, opts: { text: string; wordId?: number | string }) {
  const el = requireCaption(ctx, id);
  if (opts.wordId !== undefined) {
    const w = el.words.find((x) => String(x.id) === String(opts.wordId));
    if (!w) throw new EditError("INVALID_ARGUMENT", `No word ${opts.wordId} in caption ${id}`);
    w.text = opts.text;
  } else {
    const tokens = opts.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) throw new EditError("INVALID_ARGUMENT", "Caption text cannot be empty (delete the caption instead)");
    if (tokens.length === el.words.length) {
      tokens.forEach((t, i) => (el.words[i].text = t));
    } else {
      const first = el.words[0].startOffsetSeconds;
      const last = el.words[el.words.length - 1].endOffsetSeconds;
      const span = Math.max(last - first, EPS);
      el.words = tokens.map((t, i) => ({
        id: `${el.id}_w${i + 1}`,
        text: t,
        startOffsetSeconds: cleanTime(first + (span * i) / tokens.length),
        endOffsetSeconds: cleanTime(first + (span * (i + 1)) / tokens.length),
        highlighted: false,
      }));
    }
  }
  ctx.touch(id);
}

/** Split a caption segment before the given word. */
export function splitCaption(ctx: EditContext, id: string, beforeWordId: number | string): CaptionElement {
  const el = requireCaption(ctx, id);
  const idx = el.words.findIndex((w) => String(w.id) === String(beforeWordId));
  if (idx <= 0) throw new EditError("INVALID_ARGUMENT", `Word ${beforeWordId} must exist and not be the first word of ${id}`);
  const cut = el.words[idx].startOffsetSeconds;
  const rightWords = el.words.slice(idx).map((w) => ({ ...w, startOffsetSeconds: cleanTime(w.startOffsetSeconds - cut), endOffsetSeconds: cleanTime(w.endOffsetSeconds - cut) }));
  const right: CaptionElement = { ...plainClone(el), words: [] as CaptionWord[] };
  right.id = ctx.ids("el");
  right.start = cleanTime(el.start + cut);
  right.duration = cleanTime(el.duration - cut);
  right.words = rightWords;
  delete right.anchor;
  el.words = el.words.slice(0, idx);
  el.duration = cleanTime(Math.max(cut, EPS * 10));
  ctx.draft.elements[right.id] = right;
  const track = ctx.draft.tracks.find((t) => t.id === el.trackId)!;
  track.elementIds.push(right.id);
  ctx.positioned.add(el.id);
  ctx.positioned.add(right.id);
  ctx.touch(el.id, right.id);
  ctx.created.push(right.id);
  return right;
}

/** Merge caption segments into the earliest one (they must be on the same track). */
export function mergeCaptions(ctx: EditContext, ids: string[]): CaptionElement {
  if (ids.length < 2) throw new EditError("INVALID_ARGUMENT", "mergeCaptions needs at least two caption ids");
  const els = ids.map((id) => requireCaption(ctx, id)).sort((a, b) => a.start - b.start);
  const first = els[0];
  const end = Math.max(...els.map((e) => e.start + e.duration));
  const words: CaptionWord[] = [];
  for (const e of els) {
    for (const w of e.words) {
      words.push({ ...w, startOffsetSeconds: cleanTime(w.startOffsetSeconds + e.start - first.start), endOffsetSeconds: cleanTime(w.endOffsetSeconds + e.start - first.start) });
    }
  }
  first.words = words;
  first.duration = cleanTime(end - first.start);
  for (const e of els.slice(1)) {
    const t = ctx.draft.tracks.find((tr) => tr.id === e.trackId);
    if (t) t.elementIds = t.elementIds.filter((x) => x !== e.id);
    delete ctx.draft.elements[e.id];
    ctx.removed.push(e.id);
  }
  ctx.positioned.add(first.id);
  ctx.touch(first.id);
  return first;
}

export function setCaptionStyle(ctx: EditContext, ids: string[], styleId: string, overrides?: Partial<TextStyle>, highlightColor?: string) {
  for (const id of ids) {
    const el = requireCaption(ctx, id);
    el.styleId = styleId;
    if (overrides) el.styleOverrides = { ...overrides };
    else el.styleOverrides = {};
    if (highlightColor) el.highlightColor = highlightColor;
    ctx.touch(id);
  }
}

export function setCaptionHighlights(ctx: EditContext, id: string, wordIds: (number | string)[], highlighted: boolean) {
  const el = requireCaption(ctx, id);
  const set = new Set(wordIds.map(String));
  let n = 0;
  for (const w of el.words) if (set.has(String(w.id))) {
    w.highlighted = highlighted;
    n++;
  }
  if (n === 0) throw new EditError("INVALID_ARGUMENT", `None of the word ids exist in caption ${id}`, { wordIds });
  ctx.touch(id);
}

export function setCaptionHighlightColor(ctx: EditContext, ids: string[], color: string) {
  for (const id of ids) {
    const el = requireCaption(ctx, id);
    el.highlightColor = color.toUpperCase();
    ctx.touch(id);
  }
}

// ---------------------------------------------------------------- shapes, stickers, adjustment layers

export function addShape(
  ctx: EditContext,
  opts: Pick<ShapeElement, "shape" | "widthNorm" | "heightNorm" | "fillColor"> &
    Partial<Pick<ShapeElement, "gradientToColor" | "strokeColor" | "strokeWidth" | "cornerRadius" | "opacity">> & {
      start: number;
      duration: number;
      transform?: Partial<Transform>;
      trackId?: string;
    },
): ShapeElement {
  const el: ShapeElement = {
    type: "shape",
    id: ctx.ids("el"),
    trackId: "",
    name: opts.shape,
    start: cleanTime(Math.max(0, opts.start)),
    duration: cleanTime(opts.duration),
    ...defaultVisualProps({ fit: "contain", ...opts.transform }),
    opacity: opts.opacity ?? 1,
    shape: opts.shape,
    widthNorm: opts.widthNorm,
    heightNorm: opts.heightNorm,
    fillColor: opts.fillColor.toUpperCase(),
    ...(opts.gradientToColor ? { gradientToColor: opts.gradientToColor.toUpperCase() } : {}),
    ...(opts.strokeColor ? { strokeColor: opts.strokeColor.toUpperCase() } : {}),
    strokeWidth: opts.strokeWidth ?? 0,
    cornerRadius: opts.cornerRadius ?? 0,
  };
  placeFreeElement(ctx, el, opts.trackId);
  return el;
}

export function addSticker(
  ctx: EditContext,
  opts: { stickerId?: string; cutoutMaskId?: string; start: number; duration: number; transform?: Partial<Transform>; trackId?: string; name?: string },
): StickerElement {
  if (!opts.stickerId && !opts.cutoutMaskId) throw new EditError("INVALID_ARGUMENT", "Provide stickerId or cutoutMaskId");
  const el: StickerElement = {
    type: "sticker",
    id: ctx.ids("el"),
    trackId: "",
    name: opts.name ?? opts.stickerId ?? "cutout",
    start: cleanTime(Math.max(0, opts.start)),
    duration: cleanTime(opts.duration),
    ...defaultVisualProps({ fit: "contain", scale: 0.3, ...opts.transform }),
    ...(opts.stickerId ? { stickerId: opts.stickerId } : {}),
    ...(opts.cutoutMaskId ? { cutoutMaskId: opts.cutoutMaskId } : {}),
  };
  placeFreeElement(ctx, el, opts.trackId);
  return el;
}

export function addAdjustmentLayer(ctx: EditContext, opts: { start: number; duration: number; name?: string; trackId?: string }): AdjustmentElement {
  const el: AdjustmentElement = {
    type: "adjustment",
    id: ctx.ids("el"),
    trackId: "",
    name: opts.name ?? "Adjustment layer",
    start: cleanTime(Math.max(0, opts.start)),
    duration: cleanTime(opts.duration),
    opacity: 1,
    keyframes: {},
    color: defaultColor(),
    effects: [],
  };
  placeFreeElement(ctx, el, opts.trackId);
  return el;
}

export function setTextPosition(ctx: EditContext, id: string, pos: { x?: number; y?: number; preset?: string }) {
  const el = requireElement(ctx.draft, id);
  if (el.type !== "text" && el.type !== "caption") throw new EditError("INVALID_ELEMENT_TYPE", `Element ${id} (${el.type}) is not text`);
  assertUnlocked(ctx.draft, el);
  let x = pos.x;
  let y = pos.y;
  if (pos.preset) {
    const p = TEXT_POSITIONS[pos.preset];
    if (!p) throw new EditError("INVALID_ARGUMENT", `Unknown position preset ${pos.preset}`, { presets: Object.keys(TEXT_POSITIONS) });
    x ??= p.x;
    y ??= p.y;
  }
  if (x !== undefined) el.transform.x = x;
  if (y !== undefined) el.transform.y = y;
  ctx.touch(id);
}

export { defaultMask, defaultTransform, type Element };
