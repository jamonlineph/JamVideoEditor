import type { Crop, ImageElement, VideoElement } from "../schema.js";
import { EditError } from "../errors.js";
import { baselineFit, canvasPixelSize, croppedSize } from "../canvas.js";
import { cleanTime } from "../units.js";
import { assertUnlocked } from "../timeline/query.js";
import type { EditContext } from "./context.js";
import { setKeyframe } from "./visual.js";
import { evaluateKeyframes } from "../keyframes.js";
import { splitScreen } from "./visual.js";

export interface SubjectSample {
  /** Timeline seconds. */
  time: number;
  /** Subject center, normalized to the full source frame (top-left origin). */
  x: number;
  y: number;
}

type Framed = VideoElement | ImageElement;

/** Subject position inside the cropped picture. */
function inCrop(v: number, lo: number, hi: number) {
  return (v - lo) / Math.max(1e-6, 1 - lo - hi);
}

/**
 * Element center (normalized canvas coords) that puts the subject at the canvas center while the
 * element keeps covering the canvas (no exposed edges).
 */
export function framingFor(ctx: EditContext, el: Framed, subject: { x: number; y: number }): { x: number; y: number } {
  const project = ctx.draft;
  const media = project.media[el.mediaId];
  if (!media?.width || !media?.height) throw new EditError("UNSUPPORTED_MEDIA", `No dimensions for the media of ${el.id}`);
  const canvas = canvasPixelSize(project.canvas);
  const crop = el.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const base = baselineFit(canvas, croppedSize({ width: media.width, height: media.height }, crop), el.transform.fit);
  const w = base.width * el.transform.scale;
  const h = base.height * el.transform.scale;
  const axis = (s: number, size: number, total: number) => {
    const ideal = 0.5 + (0.5 - s) * (size / total);
    if (size <= total + 1e-6) return 0.5;
    const lo = 1 - size / (2 * total);
    const hi = size / (2 * total);
    return Math.min(hi, Math.max(lo, ideal));
  };
  return {
    x: cleanTime(axis(inCrop(subject.x, crop.left, crop.right), w, canvas.width)),
    y: cleanTime(axis(inCrop(subject.y, crop.top, crop.bottom), h, canvas.height)),
  };
}

function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0.5;
}

/** Centered moving average over `radius` samples. */
export function smoothPath(samples: SubjectSample[], radius = 2): SubjectSample[] {
  return samples.map((s, i) => {
    const win = samples.slice(Math.max(0, i - radius), i + radius + 1);
    return { time: s.time, x: win.reduce((a, b) => a + b.x, 0) / win.length, y: win.reduce((a, b) => a + b.y, 0) / win.length };
  });
}

/** Frame a clip on its subject: one static position, or keyframes that follow the subject. */
export function reframeElement(ctx: EditContext, el: Framed, samples: SubjectSample[], mode: "static" | "follow"): { keyframes: number; x: number; y: number } {
  assertUnlocked(ctx.draft, el);
  if (!samples.length) throw new EditError("INVALID_ARGUMENT", `No subject samples for ${el.id}`);
  el.transform.fit = "cover";
  delete el.keyframes.x;
  delete el.keyframes.y;
  const still = framingFor(ctx, el, { x: median(samples.map((s) => s.x)), y: median(samples.map((s) => s.y)) });
  el.transform.x = still.x;
  el.transform.y = still.y;
  ctx.touch(el.id);
  if (mode === "static" || samples.length < 2) return { keyframes: 0, ...still };
  // Follow: smoothed path with a dead zone so small head movements do not wobble the frame.
  const path = smoothPath(samples).map((s) => ({ time: s.time, ...framingFor(ctx, el, s) }));
  const keep = [path[0]];
  for (const p of path.slice(1)) {
    const last = keep[keep.length - 1];
    if (Math.abs(p.x - last.x) > 0.015 || Math.abs(p.y - last.y) > 0.015) keep.push(p);
  }
  if (keep.length === 1) return { keyframes: 0, ...still };
  const last = path[path.length - 1];
  if (keep[keep.length - 1] !== last) keep.push(last);
  for (const p of keep) {
    const offsetSeconds = Math.min(el.duration, Math.max(0, p.time - el.start));
    setKeyframe(ctx, el, { property: "x", offsetSeconds, value: p.x, easing: { type: "easeInOut" } });
    setKeyframe(ctx, el, { property: "y", offsetSeconds, value: p.y, easing: { type: "easeInOut" } });
  }
  return { keyframes: keep.length, ...still };
}

/** Shift a crop window so `center` (normalized source x) is in the middle, keeping its width. */
export function cropAround(crop: Crop, center: number): Crop {
  const visible = 1 - crop.left - crop.right;
  const left = Math.min(1 - visible, Math.max(0, center - visible / 2));
  return { ...crop, left, right: Math.max(0, 1 - visible - left) };
}

/**
 * Two speakers too far apart for one vertical frame: stack them, each panel cropped onto one person.
 * `a` and `b` are the two subject centers (normalized source x), left to right.
 */
export function stackTwoSpeakers(ctx: EditContext, el: VideoElement, a: number, b: number, gap = 0.01) {
  const res = splitScreen(ctx, { elementIds: [el.id], layout: "stack2", gap, background: { type: "blur" } });
  const [top, bottom] = res.panelIds.map((id) => ctx.draft.elements[id] as Framed);
  if (top.crop) top.crop = cropAround(top.crop, a);
  if (bottom.crop) bottom.crop = cropAround(bottom.crop, b);
  return res;
}

/**
 * Where a point of the source frame (normalized, top-left origin) appears on the canvas at a timeline
 * time, through the clip's crop, flip, scale and position (keyframes included; rotation ignored).
 * Also returns how many canvas pixels one source-width unit spans.
 */
export function sourceToCanvas(project: import("../schema.js").Project, el: Framed, sx: number, sy: number, time: number): { x: number; y: number; pxPerSourceWidth: number; pxPerSourceHeight: number } {
  const media = project.media[el.mediaId];
  const canvas = canvasPixelSize(project.canvas);
  const crop = el.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const base = baselineFit(canvas, croppedSize({ width: media?.width ?? canvas.width, height: media?.height ?? canvas.height }, crop), el.transform.fit);
  const scale = evaluate(el, "scale", time);
  const w = base.width * scale;
  const h = base.height * scale;
  let u = inCrop(sx, crop.left, crop.right);
  let v = inCrop(sy, crop.top, crop.bottom);
  if (el.flip.horizontal) u = 1 - u;
  if (el.flip.vertical) v = 1 - v;
  const cx = evaluate(el, "x", time) * canvas.width;
  const cy = evaluate(el, "y", time) * canvas.height;
  const visibleW = 1 - crop.left - crop.right;
  const visibleH = 1 - crop.top - crop.bottom;
  return { x: (cx + (u - 0.5) * w) / canvas.width, y: (cy + (v - 0.5) * h) / canvas.height, pxPerSourceWidth: w / visibleW, pxPerSourceHeight: h / visibleH };
}

function evaluate(el: Framed, prop: "x" | "y" | "scale", time: number): number {
  const kfs = el.keyframes[prop];
  if (!kfs?.length) return el.transform[prop];
  return evaluateKeyframes(kfs, time - el.start, el.transform[prop]);
}
