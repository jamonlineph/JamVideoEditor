import type {
  CaptionElement,
  CaptionWord,
  ColorGrade,
  ColorSettings,
  Crop,
  EffectInstance,
  Element,
  Flip,
  ImageElement,
  Mask,
  Project,
  ShapeElement,
  StickerElement,
  TextElement,
  TextStyle,
  VideoElement,
} from "../schema.js";
import { COLOR_GRADE_KEYS } from "../schema.js";
import { EPS } from "../units.js";
import { baselineFit, croppedSize } from "../canvas.js";
import { evaluateProperty } from "../ops/visual.js";
import { isAudioKind, mainTrack, mainTrackDuration, compositionDuration } from "../timeline/query.js";
import { findCatalogItem } from "../catalog/index.js";
import { WHOLE_CLIP_ANIMATIONS } from "../catalog/visual.js";
import { defaultTextStyle } from "../defaults.js";
import type { CaptionStyleData } from "../catalog/text.js";
import { sourceTimeAt } from "./timeMap.js";

export interface RenderSize {
  width: number;
  height: number;
}

export interface ResolvedColor {
  /** Grade sliders with the filter look already folded in. */
  grade: ColorGrade;
  wheels: ColorSettings["wheels"];
  hsl: ColorSettings["hsl"];
  curves: ColorSettings["curves"];
  lut?: { id: string; cubePath?: string; intensity: number };
}

interface LayerCommon {
  elementId: string;
  /** Center in output pixels. */
  cx: number;
  cy: number;
  rotationDegrees: number;
  opacity: number;
  blendMode: string;
  mask: Mask;
  color: ResolvedColor | null;
  effects: EffectInstance[];
  /** Effects limited to (or around) a tracked subject; drawn with the masks in MediaLayer.subjectMasks. */
  subjectEffects: EffectInstance[];
}

export interface MediaLayer extends LayerCommon {
  kind: "media";
  mediaKind: "video" | "image";
  mediaId: string;
  width: number;
  height: number;
  crop: Crop;
  flip: Flip;
  /** Source timestamp to show. */
  sourceSeconds: number;
  reversed: boolean;
  sourceInSourceSeconds: number;
  sourceDurationSourceSeconds: number;
  /** Per-frame subject masks for subject effects (mask video media and the matching mask time). */
  subjectMasks: { instanceId: string; maskMediaId: string; maskSeconds: number }[];
}

export interface TextLayer extends LayerCommon {
  kind: "text";
  text: string;
  style: TextStyle;
  fontPx: number;
  maxWidthPx: number;
  emphasis: TextElement["emphasis"];
  /** 0..1 fraction of the text revealed (typewriter-style animations). */
  reveal: number;
  revealUnit: "char" | "word";
}

export interface CaptionLayer extends LayerCommon {
  kind: "caption";
  words: CaptionWord[];
  localSeconds: number;
  style: TextStyle;
  fontPx: number;
  maxWidthPx: number;
  mode: CaptionStyleData["mode"];
  maxWords: number;
  highlightColor: string;
  activeWordScale: number;
}

export interface ShapeLayer extends LayerCommon {
  kind: "shape";
  shape: ShapeElement["shape"];
  width: number;
  height: number;
  fillColor: string;
  gradientToColor?: string;
  strokeColor?: string;
  strokeWidthPx: number;
  cornerRadius: number;
}

/** One colored path of a multi-color sticker (24x24 viewBox). */
export interface StickerPart {
  d: string;
  fill: string;
}

export interface StickerLayer extends LayerCommon {
  kind: "sticker";
  width: number;
  height: number;
  stickerId: string;
  svgPath: string;
  fillColor: string;
  /** Colored layers drawn in order instead of svgPath in fillColor. */
  parts?: StickerPart[];
}

export interface AdjustmentLayer {
  kind: "adjustment";
  elementId: string;
  opacity: number;
  color: ResolvedColor | null;
  effects: EffectInstance[];
}

export interface TransitionLayer {
  kind: "transition";
  elementId: string;
  type: string;
  /** 0..1 */
  progress: number;
  from: MediaLayer | null;
  to: MediaLayer | null;
}

export type DrawLayer = MediaLayer | TextLayer | CaptionLayer | ShapeLayer | StickerLayer;
export type SceneLayer = DrawLayer | AdjustmentLayer | TransitionLayer;

export interface Scene {
  timeSeconds: number;
  width: number;
  height: number;
  backgroundColor: string;
  layers: SceneLayer[];
}

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 };

function isIdentityCurve(points: { x: number; y: number }[]) {
  return points.every((p) => Math.abs(p.x - p.y) < 1e-6);
}

/** Folds the filter look into the grade; returns null when nothing would change the image. */
export function resolveColor(color: ColorSettings): ResolvedColor | null {
  const grade = { ...color.grade };
  if (color.filter) {
    const look = (findCatalogItem("filters", color.filter.id)?.data as { grade?: Partial<ColorGrade> } | undefined)?.grade ?? {};
    for (const k of COLOR_GRADE_KEYS) {
      const add = (look[k] ?? 0) * (color.filter.intensity / 100);
      grade[k] = Math.max(k === "fade" ? 0 : -100, Math.min(100, grade[k] + add));
    }
  }
  const gradeIdentity = COLOR_GRADE_KEYS.every((k) => grade[k] === 0);
  const wheelsIdentity = Object.values(color.wheels).every((w) => w.intensity === 0);
  const hslIdentity = Object.values(color.hsl).every((b) => b.hue === 0 && b.saturation === 0 && b.luminance === 0);
  const curvesIdentity = Object.values(color.curves).every(isIdentityCurve);
  if (gradeIdentity && wheelsIdentity && hslIdentity && curvesIdentity && !color.lut) return null;
  return { grade, wheels: color.wheels, hsl: color.hsl, curves: color.curves, ...(color.lut ? { lut: color.lut } : {}) };
}

function resolveMask(el: Element & { mask: Mask }, t: number): Mask {
  const m = el.mask;
  if (m.type === "none") return m;
  const v = (k: "centerX" | "centerY" | "sizeW" | "sizeH" | "rotation" | "feather" | "cornerRadius") => (el.keyframes[`mask.${k}`]?.length ? evaluateProperty(el, `mask.${k}`, t) : m[k]);
  return { ...m, centerX: v("centerX"), centerY: v("centerY"), sizeW: v("sizeW"), sizeH: v("sizeH"), rotation: v("rotation"), feather: v("feather"), cornerRadius: v("cornerRadius") };
}

type Visual = Exclude<Element, { type: "audio" | "adjustment" }>;

function common(el: Visual, t: number, size: RenderSize): LayerCommon & { scale: number } {
  return {
    elementId: el.id,
    cx: evaluateProperty(el, "x", t) * size.width,
    cy: evaluateProperty(el, "y", t) * size.height,
    rotationDegrees: evaluateProperty(el, "rotationDegrees", t),
    scale: evaluateProperty(el, "scale", t),
    opacity: Math.max(0, Math.min(1, evaluateProperty(el, "opacity", t))),
    blendMode: el.blendMode,
    mask: resolveMask(el, t),
    color: resolveColor(el.color),
    // Subject effects run in their own pass with a mask (see MediaLayer.subjectMasks).
    effects: el.effects.filter((fx) => !fx.subjectMaskId),
    subjectEffects: el.effects.filter((fx) => !!fx.subjectMaskId),
  };
}

function mediaLayer(project: Project, el: VideoElement | ImageElement, t: number, size: RenderSize, extrapolate = false): MediaLayer {
  const { scale, ...base } = common(el, t, size);
  const media = project.media[el.mediaId];
  const dims = { width: media?.width ?? size.width, height: media?.height ?? size.height };
  const crop = el.crop ?? NO_CROP;
  const fitted = baselineFit(size, croppedSize(dims, crop), el.transform.fit);
  return animate({
    ...base,
    kind: "media",
    mediaKind: el.type,
    mediaId: el.mediaId,
    width: fitted.width * scale,
    height: fitted.height * scale,
    crop,
    flip: el.flip,
    sourceSeconds: el.type === "video" ? videoSourceTime(project, el, t, extrapolate) : 0,
    reversed: el.type === "video" ? el.reversed : false,
    sourceInSourceSeconds: el.type === "video" ? el.sourceInSourceSeconds : 0,
    sourceDurationSourceSeconds: el.type === "video" ? el.sourceDurationSourceSeconds : 0,
    subjectMasks: subjectMasks(project, el, el.type === "video" ? videoSourceTime(project, el, t, extrapolate) : 0),
  } satisfies MediaLayer, el, t, size);
}

/** Subject effects reference a mask video; its frame 0 matches `maskStartSourceSeconds` of the clip's source. */
function subjectMasks(project: Project, el: VideoElement | ImageElement, sourceSeconds: number) {
  return el.effects
    .filter((fx) => fx.subjectMaskId && project.media[fx.subjectMaskId])
    .map((fx) => ({
      instanceId: fx.instanceId,
      maskMediaId: fx.subjectMaskId!,
      maskSeconds: Math.max(0, sourceSeconds - (typeof fx.params.maskStartSourceSeconds === "number" ? fx.params.maskStartSourceSeconds : 0)),
    }));
}

/** Source time of the frame to show. Reversed clips show the frame that ends at that instant, so the last frame plays first. */
function videoSourceTime(project: Project, el: VideoElement, t: number, extrapolate: boolean): number {
  const source = sourceTimeAt(project, el, t, { extrapolate });
  if (!el.reversed) return source;
  const fps = project.media[el.mediaId]?.fps ?? project.canvas.fps;
  return Math.max(el.sourceInSourceSeconds, source - 1 / fps);
}

/** A cutout sticker is drawn like an image: its cutout PNG is a media asset. */
function cutoutLayer(project: Project, el: StickerElement, t: number, size: RenderSize): MediaLayer {
  const { scale, ...base } = common(el, t, size);
  const media = project.media[el.cutoutMaskId!];
  const fitted = baselineFit(size, { width: media.width ?? 512, height: media.height ?? 512 }, "contain");
  return animate({
    ...base,
    kind: "media",
    mediaKind: "image",
    mediaId: media.id,
    width: fitted.width * scale,
    height: fitted.height * scale,
    crop: NO_CROP,
    flip: { horizontal: false, vertical: false },
    sourceSeconds: 0,
    reversed: false,
    sourceInSourceSeconds: 0,
    sourceDurationSourceSeconds: 0,
    subjectMasks: [],
  } satisfies MediaLayer, el, t, size);
}

interface Anim {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
  reveal: number;
  revealUnit: "char" | "word";
  /** 0..1 blur strength (blur in/out). */
  blur: number;
}

const TAU = Math.PI * 2;
const clamp01 = (p: number) => Math.max(0, Math.min(1, p));
const easeOut = (p: number) => 1 - Math.pow(1 - clamp01(p), 3);
const easeInOut = (p: number) => {
  const x = clamp01(p);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
/** Overshoots past 1 and settles (pop). */
const backOut = (p: number) => {
  const x = clamp01(p) - 1;
  return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
};
/** Falls and bounces to rest at 1. */
const bounceOut = (p: number) => {
  let x = clamp01(p);
  const n = 7.5625;
  const d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
};

/** Evaluates in / out / loop text animations at an element-local time. */
export function evaluateTextAnimation(el: TextElement, local: number): Anim {
  const a: Anim = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, reveal: 1, revealUnit: "char", blur: 0 };
  const enter = (id: string, lin: number) => {
    const p = easeOut(lin);
    switch (id) {
      case "slide_up":
        a.dy += (1 - p) * 0.08;
        a.opacity *= p;
        break;
      case "slide_down":
        a.dy -= (1 - p) * 0.08;
        a.opacity *= p;
        break;
      case "slide_left":
        a.dx += (1 - p) * 0.15;
        a.opacity *= p;
        break;
      case "slide_right":
        a.dx -= (1 - p) * 0.15;
        a.opacity *= p;
        break;
      case "zoom_in":
      case "zoom_out":
        a.scale *= 0.6 + 0.4 * p;
        a.opacity *= p;
        break;
      case "pop_in":
      case "pop_out":
        a.scale *= 0.5 + 0.5 * p + 0.2 * Math.sin(Math.PI * Math.min(1, lin));
        a.opacity *= Math.min(1, lin * 3);
        break;
      case "typewriter":
        a.reveal = Math.min(a.reveal, lin);
        break;
      case "word_by_word":
        a.reveal = Math.min(a.reveal, lin);
        a.revealUnit = "word";
        break;
      case "slide_out_up":
        a.dy -= (1 - p) * 0.08;
        a.opacity *= p;
        break;
      case "slide_out_down":
        a.dy += (1 - p) * 0.08;
        a.opacity *= p;
        break;
      case "slide_out_left":
        a.dx -= (1 - p) * 0.15;
        a.opacity *= p;
        break;
      case "slide_out_right":
        a.dx += (1 - p) * 0.15;
        a.opacity *= p;
        break;
      case "bounce_in":
        a.dy -= (1 - bounceOut(lin)) * 0.12;
        a.opacity *= Math.min(1, lin * 4);
        break;
      case "drop_in":
        a.dy -= (1 - p) * 0.12;
        a.scale *= 1.6 - 0.6 * p;
        a.opacity *= p;
        break;
      case "spin_in":
        a.rotation -= (1 - p) * 360;
        a.scale *= Math.max(0.01, p);
        break;
      case "spin_out":
        a.rotation += (1 - p) * 360;
        a.scale *= Math.max(0.01, p);
        break;
      case "swing_in":
        a.rotation += 25 * (1 - lin) * Math.cos(lin * Math.PI * 3);
        a.opacity *= Math.min(1, lin * 3);
        break;
      case "erase":
        a.reveal = Math.min(a.reveal, lin);
        break;
      case "blur_in":
      case "blur_out":
        a.blur = Math.max(a.blur, 1 - p);
        a.opacity *= Math.min(1, lin * 2);
        break;
      default:
        a.opacity *= p; // fade_in, fade_out
    }
  };
  const anim = el.animation;
  if (anim.in && local < anim.in.durationSeconds) enter(anim.in.id, Math.max(0, local / anim.in.durationSeconds));
  if (anim.out && el.duration - local < anim.out.durationSeconds) enter(anim.out.id, Math.max(0, (el.duration - local) / anim.out.durationSeconds));
  if (anim.loop) {
    const phase = (local / anim.loop.durationSeconds) * TAU;
    switch (anim.loop.id) {
      case "pulse":
        a.scale *= 1 + 0.05 * Math.sin(phase);
        break;
      case "wiggle":
        a.rotation += 3 * Math.sin(phase);
        break;
      case "float":
        a.dy += 0.01 * Math.sin(phase);
        break;
      case "flicker":
        a.opacity *= Math.sin(phase * 7) > 0.6 ? 0.6 : 1;
        break;
      case "shake":
        a.dx += 0.004 * Math.sin(phase * 5);
        a.dy += 0.004 * Math.cos(phase * 7);
        break;
      case "glow_pulse":
        a.scale *= 1 + 0.02 * Math.sin(phase);
        break;
      case "bounce":
        a.dy -= 0.025 * Math.abs(Math.sin(phase / 2));
        break;
      case "heartbeat":
        a.scale *= 1 + 0.1 * Math.pow(Math.max(0, Math.sin(phase)), 8);
        break;
      case "swing":
        a.rotation += 8 * Math.sin(phase);
        break;
      case "spin":
        a.rotation += (local / anim.loop.durationSeconds) * 360;
        break;
      case "blink":
        a.opacity *= Math.sin(phase) > -0.2 ? 1 : 0;
        break;
    }
  }
  return a;
}

/** Motion of a clip animation at an element-local time (offsets are fractions of the canvas). */
export interface ClipMotion {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
  blur: number;
}

/** Evaluates in / out / combo animations of a video, photo, sticker or shape clip. */
export function evaluateClipAnimation(anim: TextElement["animation"] | undefined, local: number, duration: number): ClipMotion {
  const m: ClipMotion = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0 };
  if (!anim) return m;
  // `lin` runs 0 -> 1 as the clip enters, and 1 -> 0 as it leaves.
  const move = (id: string, lin: number) => {
    const p = easeOut(lin);
    const q = 1 - p;
    switch (id) {
      case "zoom_in":
      case "zoom_out":
        m.scale *= 0.5 + 0.5 * p;
        m.opacity *= Math.min(1, lin * 2);
        break;
      case "zoom_out_in":
      case "zoom_in_out":
        m.scale *= 1.5 - 0.5 * p;
        m.opacity *= p;
        break;
      case "slide_in_left":
      case "slide_out_right":
        m.dx += q;
        break;
      case "slide_in_right":
      case "slide_out_left":
        m.dx -= q;
        break;
      case "slide_in_up":
      case "slide_out_down":
        m.dy += q;
        break;
      case "slide_in_down":
      case "slide_out_up":
        m.dy -= q;
        break;
      case "rotate_in":
        m.rotation -= q * 90;
        m.scale *= 0.7 + 0.3 * p;
        m.opacity *= p;
        break;
      case "rotate_out":
        m.rotation += q * 90;
        m.scale *= 0.7 + 0.3 * p;
        m.opacity *= p;
        break;
      case "spin_in":
        m.rotation -= q * 360;
        m.scale *= Math.max(0.01, p);
        break;
      case "spin_out":
        m.rotation += q * 360;
        m.scale *= Math.max(0.01, p);
        break;
      case "blur_in":
      case "blur_out":
        m.blur = Math.max(m.blur, q);
        m.opacity *= Math.min(1, lin * 3);
        break;
      case "pop_in":
      case "pop_out":
        m.scale *= Math.max(0.01, backOut(lin));
        m.opacity *= Math.min(1, lin * 4);
        break;
      case "drop_in":
        m.dy -= 1 - bounceOut(lin);
        break;
      case "swing_in":
        m.rotation += 25 * (1 - lin) * Math.cos(lin * Math.PI * 3);
        m.opacity *= Math.min(1, lin * 3);
        break;
      case "fall_out": {
        const f = 1 - clamp01(lin);
        m.dy += f * f * 1.2;
        m.rotation += f * 25;
        break;
      }
      default:
        m.opacity *= p; // fade_in, fade_out
    }
  };
  if (anim.in && local < anim.in.durationSeconds) move(anim.in.id, Math.max(0, local / anim.in.durationSeconds));
  if (anim.out && duration - local < anim.out.durationSeconds) move(anim.out.id, Math.max(0, (duration - local) / anim.out.durationSeconds));
  if (anim.loop) {
    const id = anim.loop.id;
    const whole = WHOLE_CLIP_ANIMATIONS.has(id) ? easeInOut(local / Math.max(duration, 1e-3)) : 0;
    const phase = (local / anim.loop.durationSeconds) * TAU;
    switch (id) {
      case "ken_burns":
        m.scale *= 1 + 0.18 * whole;
        break;
      case "slow_zoom_out":
        m.scale *= 1.18 - 0.18 * whole;
        break;
      case "pan_left":
        m.scale *= 1.15;
        m.dx += 0.06 - 0.12 * whole;
        break;
      case "pan_right":
        m.scale *= 1.15;
        m.dx -= 0.06 - 0.12 * whole;
        break;
      case "pulse":
        m.scale *= 1 + 0.04 * Math.sin(phase);
        break;
      case "heartbeat":
        m.scale *= 1 + 0.08 * Math.pow(Math.max(0, Math.sin(phase)), 8);
        break;
      case "rock":
        m.rotation += 4 * Math.sin(phase);
        break;
      case "float":
        m.dy += 0.015 * Math.sin(phase);
        break;
      case "shake":
        m.scale *= 1.04;
        m.dx += 0.01 * Math.sin(phase * 5);
        m.dy += 0.01 * Math.cos(phase * 7);
        break;
      case "wobble":
        m.rotation += 3 * Math.sin(phase);
        m.scale *= 1 + 0.03 * Math.sin(phase * 2);
        break;
      case "spin":
        m.rotation += (local / anim.loop.durationSeconds) * 360;
        break;
    }
  }
  return m;
}

/** A blur pass for blur in / out animations (drawn by the compositor's blur effect). */
function motionBlur(blur: number): EffectInstance[] {
  return blur > 0.005 ? [{ instanceId: "__motion_blur", effectId: "blur", intensity: Math.min(100, blur * 100), params: { radius: 60 } }] : [];
}

/** Moves, scales, rotates and fades a drawn layer by a clip animation. */
function animate<L extends MediaLayer | ShapeLayer | StickerLayer>(layer: L, el: Element, t: number, size: RenderSize): L {
  const anim = (el as { animation?: TextElement["animation"] }).animation;
  if (!anim || (!anim.in && !anim.out && !anim.loop)) return layer;
  const m = evaluateClipAnimation(anim, t - el.start, el.duration);
  return {
    ...layer,
    cx: layer.cx + m.dx * size.width,
    cy: layer.cy + m.dy * size.height,
    width: layer.width * m.scale,
    height: layer.height * m.scale,
    rotationDegrees: layer.rotationDegrees + m.rotation,
    opacity: layer.opacity * m.opacity,
    effects: [...layer.effects, ...motionBlur(m.blur)],
  };
}

/** Catalog caption style merged with the element's overrides. */
export function resolveCaptionStyle(el: CaptionElement): { style: TextStyle; data: CaptionStyleData } {
  const data = (findCatalogItem("captionStyles", el.styleId)?.data as CaptionStyleData | undefined) ?? {
    mode: "line",
    maxWords: 6,
    highlightColor: el.highlightColor,
    activeWordScale: 1,
    style: {},
  };
  return { style: defaultTextStyle({ ...data.style, ...el.styleOverrides }), data };
}

function drawLayer(project: Project, el: Element, t: number, size: RenderSize): DrawLayer | AdjustmentLayer | null {
  const short = Math.min(size.width, size.height);
  switch (el.type) {
    case "video":
    case "image":
      return mediaLayer(project, el, t, size);
    case "text": {
      const { scale, ...base } = common(el, t, size);
      const a = evaluateTextAnimation(el, t - el.start);
      return {
        ...base,
        kind: "text",
        cx: base.cx + a.dx * size.width,
        cy: base.cy + a.dy * size.height,
        rotationDegrees: base.rotationDegrees + a.rotation,
        opacity: base.opacity * a.opacity,
        effects: [...base.effects, ...motionBlur(a.blur)],
        text: el.text,
        style: el.style,
        fontPx: el.style.fontSizeNorm * short * scale * a.scale,
        maxWidthPx: el.style.maxWidthNorm * size.width * scale,
        emphasis: el.emphasis,
        reveal: a.reveal,
        revealUnit: a.revealUnit,
      };
    }
    case "caption": {
      const { scale, ...base } = common(el, t, size);
      const { style, data } = resolveCaptionStyle(el);
      return {
        ...base,
        kind: "caption",
        words: el.words,
        localSeconds: t - el.start,
        style,
        fontPx: style.fontSizeNorm * short * scale,
        maxWidthPx: style.maxWidthNorm * size.width * scale,
        mode: data.mode,
        maxWords: data.maxWords,
        highlightColor: el.highlightColor,
        activeWordScale: data.activeWordScale,
      };
    }
    case "shape": {
      const { scale, ...base } = common(el, t, size);
      return animate<ShapeLayer>({
        ...base,
        kind: "shape",
        shape: el.shape,
        width: el.widthNorm * size.width * scale,
        height: el.heightNorm * size.height * scale,
        fillColor: el.fillColor,
        ...(el.gradientToColor ? { gradientToColor: el.gradientToColor } : {}),
        ...(el.strokeColor ? { strokeColor: el.strokeColor } : {}),
        strokeWidthPx: el.strokeWidth * short,
        cornerRadius: el.cornerRadius,
      }, el, t, size);
    }
    case "sticker": {
      if (el.cutoutMaskId && project.media[el.cutoutMaskId]) return cutoutLayer(project, el, t, size);
      const item = el.stickerId ? (findCatalogItem("stickers", el.stickerId)?.data as { svgPath: string; defaultColor: string; parts?: StickerPart[] } | undefined) : undefined;
      if (!item) return null;
      const { scale, ...base } = common(el as StickerElement, t, size);
      return animate<StickerLayer>({ ...base, kind: "sticker", width: short * scale, height: short * scale, stickerId: el.stickerId!, svgPath: item.svgPath, fillColor: item.defaultColor, ...(item.parts ? { parts: item.parts } : {}) }, el, t, size);
    }
    case "adjustment":
      return { kind: "adjustment", elementId: el.id, opacity: Math.max(0, Math.min(1, evaluateProperty(el, "opacity", t))), color: resolveColor(el.color), effects: el.effects };
    default:
      return null;
  }
}

const active = (el: Element, t: number) => el.start <= t + EPS && t < el.start + el.duration - EPS;

function mainLayers(project: Project, t: number, size: RenderSize): SceneLayer[] {
  const main = mainTrack(project);
  if (main.hidden) return [];
  for (const tr of project.transitions) {
    const from = project.elements[tr.fromElementId];
    const to = project.elements[tr.toElementId];
    if (!from || !to) continue;
    const cut = to.start;
    const half = tr.durationSeconds / 2;
    if (t >= cut - half - EPS && t < cut + half - EPS) {
      const asMedia = (el: Element) => (el.type === "video" || el.type === "image" ? mediaLayer(project, el, t, size, true) : null);
      return [{ kind: "transition", elementId: tr.id, type: tr.type, progress: Math.max(0, Math.min(1, (t - (cut - half)) / tr.durationSeconds)), from: asMedia(from), to: asMedia(to) }];
    }
  }
  for (const id of main.elementIds) {
    const el = project.elements[id];
    if (el && active(el, t)) {
      const layer = drawLayer(project, el, t, size);
      return layer ? [layer] : [];
    }
  }
  return [];
}

/** Everything the compositor needs to draw one frame, bottom layer first. */
export function evaluateScene(project: Project, timeSeconds: number, size: RenderSize, opts: { hideCaptions?: boolean } = {}): Scene {
  const layers: SceneLayer[] = mainLayers(project, timeSeconds, size);
  for (let i = 1; i < project.tracks.length; i++) {
    const track = project.tracks[i];
    if (track.hidden || isAudioKind(track.kind) || (opts.hideCaptions && track.kind === "caption")) continue;
    for (const id of track.elementIds) {
      const el = project.elements[id];
      if (!el || !active(el, timeSeconds)) continue;
      const layer = drawLayer(project, el, timeSeconds, size);
      if (layer) layers.push(layer);
    }
  }
  return { timeSeconds, width: size.width, height: size.height, backgroundColor: project.canvas.backgroundColor, layers };
}

/** Media layers in a scene, including both sides of a transition. */
export function sceneMediaLayers(scene: Scene): MediaLayer[] {
  const out: MediaLayer[] = [];
  for (const l of scene.layers) {
    if (l.kind === "media") out.push(l);
    else if (l.kind === "transition") {
      if (l.from) out.push(l.from);
      if (l.to) out.push(l.to);
    }
  }
  return out;
}

/** Output pixel size for a render whose short side is `shortSide` (even dimensions). */
export function renderSizeFor(project: Project, shortSide: number): RenderSize {
  const [w, h] = project.canvas.aspectRatio.split(":").map(Number);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return w >= h ? { width: even((shortSide * w) / h), height: even(shortSide) } : { width: even(shortSide), height: even((shortSide * h) / w) };
}

/** Frame times for a range at the project frame rate. */
export function frameTimes(project: Project, range: { startSeconds?: number; endSeconds?: number } = {}, fps: number = project.canvas.fps): number[] {
  const start = Math.max(0, range.startSeconds ?? 0);
  const end = Math.min(range.endSeconds ?? Infinity, compositionDuration(project));
  const count = Math.max(0, Math.round((end - start) * fps));
  return Array.from({ length: count }, (_, i) => start + i / fps);
}

export { mainTrackDuration };
