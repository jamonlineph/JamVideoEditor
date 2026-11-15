import type { Canvas, Crop, Transform } from "./schema.js";

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:5"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTIONS = ["720p", "1080p", "4K"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const FRAME_RATES = [24, 25, 30, 50, 60] as const;

const SHORT_SIDE: Record<Resolution, number> = { "720p": 720, "1080p": 1080, "4K": 2160 };

export interface Size {
  width: number;
  height: number;
}

export interface PixelRect {
  /** Center x in pixels. */
  cx: number;
  /** Center y in pixels. */
  cy: number;
  width: number;
  height: number;
  rotationDegrees: number;
}

function even(n: number): number {
  return Math.round(n / 2) * 2;
}

/** Width / height ratio for an aspect ratio string. */
export function aspectValue(aspect: AspectRatio): number {
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

/**
 * Canvas pixel size. The resolution names the short side
 * (1080p 9:16 = 1080x1920, 1080p 16:9 = 1920x1080, 1080p 4:5 = 1080x1350).
 */
export function canvasPixelSize(canvas: Pick<Canvas, "aspectRatio" | "resolution">): Size {
  const short = SHORT_SIDE[canvas.resolution];
  const ratio = aspectValue(canvas.aspectRatio);
  if (ratio >= 1) return { width: even(short * ratio), height: short };
  return { width: short, height: even(short / ratio) };
}

export function canvasShortSide(canvas: Pick<Canvas, "aspectRatio" | "resolution">): number {
  const { width, height } = canvasPixelSize(canvas);
  return Math.min(width, height);
}

/** Media size after applying normalized crop insets. */
export function croppedSize(media: Size, crop?: Crop): Size {
  if (!crop) return media;
  return {
    width: media.width * Math.max(0, 1 - crop.left - crop.right),
    height: media.height * Math.max(0, 1 - crop.top - crop.bottom),
  };
}

/**
 * Size of a media element at scale 1.0. `cover` fills the canvas (cropping overflow),
 * `contain` fits entirely inside the canvas.
 */
export function baselineFit(canvasPx: Size, media: Size, fit: "cover" | "contain"): Size {
  if (media.width <= 0 || media.height <= 0) return { width: 0, height: 0 };
  const sx = canvasPx.width / media.width;
  const sy = canvasPx.height / media.height;
  const s = fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
  return { width: media.width * s, height: media.height * s };
}

export function normalizedToPixels(canvas: Pick<Canvas, "aspectRatio" | "resolution">, x: number, y: number) {
  const { width, height } = canvasPixelSize(canvas);
  return { x: x * width, y: y * height };
}

export function pixelsToNormalized(canvas: Pick<Canvas, "aspectRatio" | "resolution">, px: number, py: number) {
  const { width, height } = canvasPixelSize(canvas);
  return { x: px / width, y: py / height };
}

/**
 * Pixel-space rectangle for a media element. Because the transform is stored in
 * normalized coordinates and the size is derived from the baseline fit, changing the
 * canvas aspect ratio or resolution preserves the element's relative placement.
 */
export function mediaElementPixelRect(
  canvas: Pick<Canvas, "aspectRatio" | "resolution">,
  transform: Transform,
  media: Size,
  crop?: Crop,
): PixelRect {
  const canvasPx = canvasPixelSize(canvas);
  const base = baselineFit(canvasPx, croppedSize(media, crop), transform.fit);
  return {
    cx: transform.x * canvasPx.width,
    cy: transform.y * canvasPx.height,
    width: base.width * transform.scale,
    height: base.height * transform.scale,
    rotationDegrees: transform.rotationDegrees,
  };
}

/** Pixel rect for elements sized as fractions of the canvas (shapes). */
export function canvasFractionPixelRect(
  canvas: Pick<Canvas, "aspectRatio" | "resolution">,
  transform: Transform,
  widthNorm: number,
  heightNorm: number,
): PixelRect {
  const canvasPx = canvasPixelSize(canvas);
  return {
    cx: transform.x * canvasPx.width,
    cy: transform.y * canvasPx.height,
    width: widthNorm * canvasPx.width * transform.scale,
    height: heightNorm * canvasPx.height * transform.scale,
    rotationDegrees: transform.rotationDegrees,
  };
}

/** Text font size in pixels; `fontSizeNorm` is a fraction of the canvas short side. */
export function textFontPixels(canvas: Pick<Canvas, "aspectRatio" | "resolution">, fontSizeNorm: number, scale = 1): number {
  return fontSizeNorm * canvasShortSide(canvas) * scale;
}

/** Crop insets that center-crop media of `media` size to the target aspect ratio (w/h). */
export function centerCropToAspect(media: Size, targetAspect: number): Crop {
  const mediaAspect = media.width / media.height;
  if (Math.abs(mediaAspect - targetAspect) < 1e-9) return { left: 0, top: 0, right: 0, bottom: 0 };
  if (mediaAspect > targetAspect) {
    const keep = targetAspect / mediaAspect;
    const inset = (1 - keep) / 2;
    return { left: inset, right: inset, top: 0, bottom: 0 };
  }
  const keep = mediaAspect / targetAspect;
  const inset = (1 - keep) / 2;
  return { left: 0, right: 0, top: inset, bottom: inset };
}
