import { z } from "zod";
import {
  EditError,
  KeyframePropertySchema,
  compositionDuration,
  elementEnd,
  type CommitResult,
  type EditContext,
  type Element,
  type Project,
} from "@openedits/core";
import type { ToolContext } from "../defineTool.js";

export const expectedVersion = z
  .number()
  .int()
  .optional()
  .describe("Optimistic concurrency guard: fail with VERSION_CONFLICT if the project version differs (read it from appState/state).");

export const elementIdOpt = z.string().optional().describe("Element id. Defaults to the first selected element.");
export const timeSeconds = z.number().min(0).describe("Timeline time in seconds.");
export const hexColor = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected #RRGGBB or #RRGGBBAA");
export const keyframeProperty = KeyframePropertySchema;
export const easingInput = z.object({
  type: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "cubicBezier", "hold"]),
  bezier: z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()]).optional().describe("[x1, y1, x2, y2] for cubicBezier"),
});
export const transformInput = z.object({
  x: z.number().optional().describe("Normalized center x (0 = left, 1 = right)"),
  y: z.number().optional().describe("Normalized center y (0 = top, 1 = bottom)"),
  scale: z.number().positive().max(50).optional(),
  rotationDegrees: z.number().optional().describe("Degrees clockwise"),
  fit: z.enum(["cover", "contain"]).optional(),
});

/** Resolve an element id, falling back to the current selection. */
export function resolveElementId(ctx: ToolContext, id?: string): string {
  if (id) return id;
  const sel = ctx.host.appState.selection.elementIds;
  if (sel.length === 0) throw new EditError("INVALID_ARGUMENT", "elementId is required (nothing is selected)");
  return sel[0];
}

export function element(ctx: ToolContext, id?: string): Element {
  const resolved = resolveElementId(ctx, id);
  const el = ctx.host.project.elements[resolved];
  if (!el) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${resolved}"`, { elementId: resolved });
  return el;
}

/** Run a mutation and shape the standard result. */
export function mutate<R>(
  ctx: ToolContext,
  label: string,
  recipe: (c: EditContext) => R,
  opts: { expectedVersion?: number; skipFinalize?: boolean } = {},
  extra?: (r: R, res: CommitResult<R>) => Record<string, unknown>,
) {
  const res = ctx.host.mutate(label, ctx.source, recipe, opts);
  return {
    ok: true,
    version: res.version,
    undoLabel: res.noop ? null : res.label,
    noop: res.noop,
    changed: res.changed,
    ...(res.created.length ? { createdIds: res.created } : {}),
    ...(res.removed.length ? { removedIds: res.removed } : {}),
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
    ...(extra ? extra(res.result, res) : {}),
  };
}

export function round(n: number, digits = 6) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Compact, agent-friendly element summary. */
export function summarize(project: Project, el: Element) {
  const track = project.tracks.find((t) => t.id === el.trackId);
  const base: Record<string, unknown> = {
    id: el.id,
    type: el.type,
    trackId: el.trackId,
    trackKind: track?.kind,
    ...(el.name ? { name: el.name } : {}),
    start: round(el.start),
    end: round(elementEnd(el)),
    duration: round(el.duration),
  };
  if (el.type === "video" || el.type === "audio") {
    base.mediaId = el.mediaId;
    base.sourceInSourceSeconds = round(el.sourceInSourceSeconds);
    base.sourceDurationSourceSeconds = round(el.sourceDurationSourceSeconds);
    base.speed = el.speed.mode === "constant" ? el.speed.rate : `curve${el.speed.preset ? `:${el.speed.preset}` : ""}`;
    if (el.reversed) base.reversed = true;
    base.volume = el.volume;
    if (el.muted) base.muted = true;
  }
  if (el.type === "audio") base.role = el.role;
  if (el.type === "image") base.mediaId = el.mediaId;
  if (el.type === "text") base.text = el.text;
  if (el.type === "caption") base.text = el.words.map((w) => w.text).join(" ");
  if (el.type === "sticker") base.stickerId = el.stickerId ?? el.cutoutMaskId;
  if (el.type === "shape") base.shape = el.shape;
  if ("transform" in el) base.transform = el.transform;
  const animated = Object.entries(el.keyframes).filter(([, k]) => k && k.length).map(([p]) => p);
  if (animated.length) base.keyframed = animated;
  if (el.anchor) base.anchor = el.anchor;
  return base;
}

export function projectSummary(ctx: ToolContext) {
  const h = ctx.host;
  if (!h.isOpen) return null;
  const p = h.project;
  return {
    id: p.id,
    name: p.name,
    version: h.session.version,
    canUndo: h.session.canUndo,
    canRedo: h.session.canRedo,
    durationSeconds: round(compositionDuration(p)),
    canvas: p.canvas,
    trackCount: p.tracks.length,
    elementCount: Object.keys(p.elements).length,
    mediaCount: Object.keys(p.media).length,
  };
}

export function paginate<T>(items: T[], offset = 0, limit = 200) {
  const page = items.slice(offset, offset + limit);
  return { total: items.length, offset, nextOffset: offset + page.length < items.length ? offset + page.length : null, items: page };
}

export const pageInput = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
};

export const rangeInput = {
  from: z.number().min(0).optional().describe("Only items ending after this timeline time"),
  to: z.number().min(0).optional().describe("Only items starting before this timeline time"),
};

export function inRange(el: { start: number; duration: number }, from?: number, to?: number) {
  if (from !== undefined && el.start + el.duration <= from) return false;
  if (to !== undefined && el.start >= to) return false;
  return true;
}
