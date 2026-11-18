import type {
  BlendMode,
  Crop,
  Easing,
  Element,
  Flip,
  ImageElement,
  KeyframeProperty,
  Mask,
  Transform,
  VideoElement,
} from "../schema.js";
import { KEYFRAME_PROPERTIES } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import { evaluateKeyframes, upsertKeyframe } from "../keyframes.js";
import { aspectValue, canvasPixelSize, centerCropToAspect } from "../canvas.js";
import { assertUnlocked, isOnMain, requireElement, requireMedia } from "../timeline/query.js";
import { attachToTrack, findOrCreateLane } from "../timeline/tracks.js";
import { defaultColor, defaultMask, defaultTransform } from "../defaults.js";
import type { EditContext } from "./context.js";
import { cloneElement } from "./elements.js";
import { convertToOverlay } from "./arrange.js";
import { trimEndTo } from "./edit.js";

const TRANSFORM_PROPS = ["x", "y", "scale", "rotationDegrees"] as const;
type TransformProp = (typeof TRANSFORM_PROPS)[number];

/** Keyframeable properties for an element type. */
export function keyframeableProperties(el: Element): KeyframeProperty[] {
  switch (el.type) {
    case "audio":
      return ["volume"];
    case "adjustment":
      return ["opacity"];
    case "video":
      return [...KEYFRAME_PROPERTIES];
    default:
      return KEYFRAME_PROPERTIES.filter((p) => p !== "volume");
  }
}

/** Static (non-animated) value of a property; used as the keyframe fallback. */
export function keyframeFallback(el: Element, prop: KeyframeProperty): number {
  if (prop === "volume") return "volume" in el ? el.volume : 1;
  if (prop === "opacity") return "opacity" in el ? el.opacity : 1;
  if (prop.startsWith("mask.")) {
    if (!("mask" in el)) return 0;
    const key = prop.slice(5) as keyof Mask;
    return el.mask[key] as number;
  }
  if (!("transform" in el)) return 0;
  return el.transform[prop as TransformProp];
}

/** Evaluate a property at a timeline time (keyframes override static values). */
export function evaluateProperty(el: Element, prop: KeyframeProperty, timelineSeconds: number): number {
  return evaluateKeyframes(el.keyframes[prop], timelineSeconds - el.start, keyframeFallback(el, prop));
}

function requireVisual(el: Element): asserts el is Extract<Element, { transform: Transform }> {
  if (!("transform" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) has no transform`);
}

function requireKeyframeable(el: Element, prop: KeyframeProperty) {
  if (!keyframeableProperties(el).includes(prop)) {
    throw new EditError("INVALID_ARGUMENT", `Property "${prop}" cannot be keyframed on a ${el.type} element`, {
      allowed: keyframeableProperties(el),
    });
  }
}

/** Convert a timeline time or element-local offset into a validated offset. */
export function resolveOffset(el: Element, opts: { time?: number; offsetSeconds?: number }): number {
  const offset = opts.offsetSeconds ?? (opts.time !== undefined ? opts.time - el.start : undefined);
  if (offset === undefined) throw new EditError("INVALID_ARGUMENT", "Provide either time (timeline seconds) or offsetSeconds (seconds from element start)");
  if (offset < -EPS || offset > el.duration + EPS) {
    throw new EditError("INVALID_RANGE", `Keyframe offset ${offset.toFixed(4)}s is outside element ${el.id} (0..${el.duration}s)`);
  }
  return cleanTime(Math.min(el.duration, Math.max(0, offset)));
}

export interface TransformPatch {
  x?: number;
  y?: number;
  scale?: number;
  rotationDegrees?: number;
  fit?: "cover" | "contain";
}

/**
 * Set transform values. With `time`, animated properties get a keyframe at that time;
 * without it, static values are set (and a warning is emitted for keyframed properties).
 */
export function setTransform(ctx: EditContext, el: Element, patch: TransformPatch, time?: number) {
  requireVisual(el);
  assertUnlocked(ctx.draft, el);
  if (patch.scale !== undefined && patch.scale <= 0) throw new EditError("INVALID_RANGE", "scale must be > 0");
  if (patch.fit) el.transform.fit = patch.fit;
  for (const prop of TRANSFORM_PROPS) {
    const value = patch[prop];
    if (value === undefined) continue;
    const kfs = el.keyframes[prop];
    if (kfs && kfs.length > 0) {
      if (time !== undefined) {
        const offset = resolveOffset(el, { time });
        upsertKeyframe(kfs, { offsetSeconds: offset, value, easing: { type: "linear" } });
      } else {
        el.transform[prop] = value;
        ctx.warn(`${prop} on ${el.id} is keyframed; static value changed but keyframes still drive it (pass time to edit a keyframe)`);
      }
    } else {
      el.transform[prop] = value;
    }
  }
  ctx.touch(el.id);
}

export interface KeyframeSpec {
  property: KeyframeProperty;
  time?: number;
  offsetSeconds?: number;
  value: number;
  easing?: Easing;
}

export function setKeyframe(ctx: EditContext, el: Element, spec: KeyframeSpec): number {
  assertUnlocked(ctx.draft, el);
  requireKeyframeable(el, spec.property);
  validateEasing(spec.easing);
  const offset = resolveOffset(el, spec);
  const list = el.keyframes[spec.property] ?? [];
  upsertKeyframe(list, { offsetSeconds: offset, value: spec.value, easing: spec.easing ?? { type: "linear" } });
  el.keyframes[spec.property] = list;
  ctx.touch(el.id);
  return offset;
}

export function removeKeyframe(ctx: EditContext, el: Element, property: KeyframeProperty, opts: { time?: number; offsetSeconds?: number; all?: boolean }): number {
  assertUnlocked(ctx.draft, el);
  requireKeyframeable(el, property);
  const list = el.keyframes[property];
  if (!list || list.length === 0) throw new EditError("INVALID_ARGUMENT", `No keyframes for ${property} on ${el.id}`);
  if (opts.all) {
    const n = list.length;
    // Keep the animated value at the element start as the static value.
    const v = evaluateKeyframes(list, 0, keyframeFallback(el, property));
    delete el.keyframes[property];
    writeStatic(el, property, v);
    ctx.touch(el.id);
    return n;
  }
  const offset = resolveOffset(el, opts);
  const idx = list.findIndex((k) => Math.abs(k.offsetSeconds - offset) <= 1e-4);
  if (idx < 0) throw new EditError("INVALID_ARGUMENT", `No ${property} keyframe at offset ${offset}s on ${el.id}`, { offsets: list.map((k) => k.offsetSeconds) });
  list.splice(idx, 1);
  if (list.length === 0) delete el.keyframes[property];
  ctx.touch(el.id);
  return 1;
}

function writeStatic(el: Element, prop: KeyframeProperty, value: number) {
  if (prop === "volume" && "volume" in el) el.volume = value;
  else if (prop === "opacity" && "opacity" in el) el.opacity = value;
  else if (prop.startsWith("mask.") && "mask" in el) (el.mask as Record<string, unknown>)[prop.slice(5)] = value;
  else if ("transform" in el) el.transform[prop as TransformProp] = value;
}

function validateEasing(easing?: Easing) {
  if (easing?.type === "cubicBezier" && !easing.bezier) throw new EditError("INVALID_ARGUMENT", "cubicBezier easing requires bezier: [x1, y1, x2, y2]");
}

export function setKeyframeEasing(ctx: EditContext, el: Element, property: KeyframeProperty, opts: { time?: number; offsetSeconds?: number }, easing: Easing) {
  validateEasing(easing);
  const list = el.keyframes[property];
  if (!list || list.length === 0) throw new EditError("INVALID_ARGUMENT", `No keyframes for ${property} on ${el.id}`);
  const offset = resolveOffset(el, opts);
  const kf = list.find((k) => Math.abs(k.offsetSeconds - offset) <= 1e-4);
  if (!kf) throw new EditError("INVALID_ARGUMENT", `No ${property} keyframe at offset ${offset}s on ${el.id}`, { offsets: list.map((k) => k.offsetSeconds) });
  kf.easing = easing;
  ctx.touch(el.id);
}

// ---------------------------------------------------------------- crop / flip / opacity / mask

function requireCroppable(el: Element): asserts el is VideoElement | ImageElement {
  if (el.type !== "video" && el.type !== "image") throw new EditError("INVALID_ELEMENT_TYPE", `Crop/flip need a video or image element; ${el.id} is ${el.type}`);
}

export function setCrop(ctx: EditContext, el: Element, crop: Crop | undefined) {
  requireCroppable(el);
  assertUnlocked(ctx.draft, el);
  if (crop) {
    if (crop.left + crop.right >= 0.99 || crop.top + crop.bottom >= 0.99) throw new EditError("INVALID_RANGE", "Crop leaves no visible area");
    el.crop = crop;
  } else delete el.crop;
  ctx.touch(el.id);
}

export function setFlip(ctx: EditContext, el: Element, flip: Partial<Flip>) {
  requireCroppable(el);
  assertUnlocked(ctx.draft, el);
  el.flip = { ...el.flip, ...flip };
  ctx.touch(el.id);
}

export function setOpacity(ctx: EditContext, el: Element, opacity: number) {
  if (!("opacity" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) has no opacity`);
  assertUnlocked(ctx.draft, el);
  el.opacity = opacity;
  if (el.keyframes.opacity?.length) ctx.warn(`opacity on ${el.id} is keyframed; keyframes still drive it`);
  ctx.touch(el.id);
}

type AnimationSlots = { in?: { id: string; durationSeconds: number }; out?: { id: string; durationSeconds: number }; loop?: { id: string; durationSeconds: number } };

/** In / out / combo animations of a video, photo, sticker or shape; id "none" clears a slot. */
export function setClipAnimation(ctx: EditContext, el: Element, anim: AnimationSlots) {
  if (el.type !== "video" && el.type !== "image" && el.type !== "sticker" && el.type !== "shape") {
    throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) has no clip animations${el.type === "text" ? "; use setTextAnimation" : ""}`);
  }
  assertUnlocked(ctx.draft, el);
  const next: AnimationSlots = { ...(el.animation ?? {}) };
  for (const k of ["in", "out", "loop"] as const) {
    const ref = anim[k];
    if (!ref) continue;
    if (ref.id === "none") delete next[k];
    else next[k] = { id: ref.id, durationSeconds: Math.min(ref.durationSeconds, k === "loop" ? 10 : el.duration) };
  }
  if (next.in && next.out && next.in.durationSeconds + next.out.durationSeconds > el.duration) {
    // Keep both inside the clip: shrink them in proportion.
    const k = el.duration / (next.in.durationSeconds + next.out.durationSeconds);
    next.in = { ...next.in, durationSeconds: next.in.durationSeconds * k };
    next.out = { ...next.out, durationSeconds: next.out.durationSeconds * k };
  }
  if (next.in || next.out || next.loop) el.animation = next;
  else delete el.animation;
  ctx.touch(el.id);
}

export function setBlendMode(ctx: EditContext, el: Element, mode: BlendMode) {
  if (!("blendMode" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) has no blend mode`);
  assertUnlocked(ctx.draft, el);
  el.blendMode = mode;
  ctx.touch(el.id);
}

export function setMask(ctx: EditContext, el: Element, patch: Partial<Mask>) {
  requireVisual(el);
  assertUnlocked(ctx.draft, el);
  const base = patch.type && patch.type !== el.mask.type && el.mask.type === "none" ? { ...defaultMask(), ...presetMask(patch.type) } : el.mask;
  el.mask = { ...base, ...patch };
  ctx.touch(el.id);
}

function presetMask(type: Mask["type"]): Partial<Mask> {
  switch (type) {
    case "line":
      return { sizeW: 2, sizeH: 1, centerY: 0.5 };
    case "shutter":
      return { sizeW: 2, sizeH: 0.4 };
    case "ellipse":
      return { sizeW: 0.6, sizeH: 0.6 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------- split screen

export interface SplitScreenOptions {
  elementIds: string[];
  layout: "stack2";
  /** Gap between panels as a fraction of canvas height. */
  gap: number;
  background: { type: "blur" | "solid"; color?: string; blurAmount?: number };
}

/**
 * One-step vertical split screen. Panels are placed on overlay lanes; the first element keeps
 * carrying the timing (and audio) underneath, treated as a blurred background or covered by a solid fill.
 */
export function splitScreen(ctx: EditContext, opts: SplitScreenOptions): { panelIds: string[]; backgroundId: string } {
  const project = ctx.draft;
  if (opts.elementIds.length < 1 || opts.elementIds.length > 2) throw new EditError("INVALID_ARGUMENT", "splitScreen takes one or two elements");
  const els = opts.elementIds.map((id) => requireElement(project, id));
  for (const el of els) {
    if (el.type !== "video" && el.type !== "image") throw new EditError("INVALID_ELEMENT_TYPE", `splitScreen needs video or image elements; ${el.id} is ${el.type}`);
    assertUnlocked(project, el);
  }
  const a = els[0] as VideoElement | ImageElement;
  let b = (els[1] ?? undefined) as VideoElement | ImageElement | undefined;
  const start = a.start;
  const end = a.start + a.duration;

  if (b && isOnMain(project, b)) {
    convertToOverlay(ctx, b, { start });
    b = project.elements[b.id] as VideoElement | ImageElement;
  }

  const canvasPx = canvasPixelSize(project.canvas);
  const panelH = (1 - opts.gap) / 2;
  const panelAspect = canvasPx.width / (canvasPx.height * panelH);

  const configurePanel = (el: VideoElement | ImageElement, centerY: number) => {
    const media = requireMedia(project, el.mediaId);
    el.crop = media.width && media.height ? centerCropToAspect({ width: media.width, height: media.height }, panelAspect) : el.crop;
    el.transform = defaultTransform({ fit: "contain", x: 0.5, y: centerY });
    for (const p of ["x", "y", "scale", "rotationDegrees"] as const) delete el.keyframes[p];
    ctx.touch(el.id);
  };

  const panels: (VideoElement | ImageElement)[] = [];
  const makePanelFrom = (src: VideoElement | ImageElement): VideoElement | ImageElement => {
    const dup = cloneElement(src);
    dup.id = ctx.ids("el");
    delete dup.anchor;
    dup.start = start;
    if (dup.type === "video") {
      dup.muted = true;
      delete dup.linkedAudioId;
    }
    project.elements[dup.id] = dup;
    const lane = findOrCreateLane(ctx, "overlay", start, start + dup.duration, { excludeId: dup.id });
    attachToTrack(project, dup, lane);
    ctx.positioned.add(dup.id);
    ctx.created.push(dup.id);
    return dup;
  };

  // Top panel.
  const top = isOnMain(project, a) ? makePanelFrom(a) : a;
  // Bottom panel.
  let bottom: VideoElement | ImageElement;
  if (b) {
    bottom = b;
    bottom.start = start;
    ctx.positioned.add(bottom.id);
    if (bottom.start + bottom.duration > end + EPS) trimEndTo(ctx, bottom, end);
  } else {
    bottom = makePanelFrom(a);
  }
  configurePanel(top, panelH / 2);
  configurePanel(bottom, 1 - panelH / 2);
  panels.push(top, bottom);

  // Background.
  let backgroundId: string;
  if (opts.background.type === "blur") {
    let bg: VideoElement | ImageElement = a;
    if (!isOnMain(project, a)) {
      bg = makePanelFrom(a);
      // Background must sit below the panels: move it to a fresh lane just above main.
      const lane = findOrCreateLane(ctx, "overlay", bg.start, bg.start + bg.duration, { excludeId: bg.id });
      attachToTrack(project, bg, lane);
      const idx = project.tracks.indexOf(lane);
      project.tracks.splice(idx, 1);
      project.tracks.splice(1, 0, lane);
    }
    bg.transform = defaultTransform({ fit: "cover" });
    bg.effects = bg.effects.filter((e) => e.effectId !== "blur");
    bg.effects.push({ instanceId: ctx.ids("fx"), effectId: "blur", intensity: opts.background.blurAmount ?? 60, params: {} });
    ctx.touch(bg.id);
    backgroundId = bg.id;
  } else {
    const color = opts.background.color ?? "#000000";
    const shapeId = ctx.ids("el");
    project.elements[shapeId] = {
      type: "shape",
      id: shapeId,
      trackId: "",
      name: "Split screen background",
      start,
      duration: cleanTime(end - start),
      transform: defaultTransform({ fit: "contain" }),
      opacity: 1,
      blendMode: "normal",
      mask: defaultMask(),
      keyframes: {},
      color: defaultColor(),
      effects: [],
      shape: "rectangle",
      widthNorm: 1,
      heightNorm: 1,
      fillColor: color.toUpperCase(),
      strokeWidth: 0,
      cornerRadius: 0,
    };
    const shapeEl = project.elements[shapeId];
    const lane = findOrCreateLane(ctx, "shape", start, end, { excludeId: shapeId });
    attachToTrack(project, shapeEl, lane);
    // Place the background lane directly above the main track (below the panels).
    const idx = project.tracks.indexOf(lane);
    project.tracks.splice(idx, 1);
    project.tracks.splice(1, 0, lane);
    ctx.positioned.add(shapeId);
    ctx.created.push(shapeId);
    backgroundId = shapeId;
  }
  void aspectValue;
  return { panelIds: panels.map((p) => p.id), backgroundId };
}
