import type { Easing, Keyframe, KeyframeProperty, Keyframes } from "./schema.js";
import { EPS, cleanTime } from "./units.js";

/** Standard CSS-like easing control points. */
export const EASING_BEZIERS: Record<"linear" | "easeIn" | "easeOut" | "easeInOut", [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** Solve a unit cubic bezier (x1, y1, x2, y2) for y at progress x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  // Newton-Raphson, then bisection fallback.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return sampleY(t);
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 60; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

/** Map linear progress p (0..1) through an easing. */
export function applyEasing(easing: Easing, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  switch (easing.type) {
    case "linear":
      return p;
    case "hold":
      return 0;
    case "cubicBezier": {
      const [x1, y1, x2, y2] = easing.bezier ?? EASING_BEZIERS.easeInOut;
      return cubicBezier(x1, y1, x2, y2, p);
    }
    default: {
      const [x1, y1, x2, y2] = EASING_BEZIERS[easing.type];
      return cubicBezier(x1, y1, x2, y2, p);
    }
  }
}

export function sortKeyframes(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.offsetSeconds - b.offsetSeconds);
}

/** Evaluate a keyframe list at an element-local offset. Returns `fallback` when empty. */
export function evaluateKeyframes(kfs: Keyframe[] | undefined, offsetSeconds: number, fallback: number): number {
  if (!kfs || kfs.length === 0) return fallback;
  if (offsetSeconds <= kfs[0].offsetSeconds) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (offsetSeconds >= last.offsetSeconds) return last.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (offsetSeconds >= a.offsetSeconds && offsetSeconds <= b.offsetSeconds) {
      const span = b.offsetSeconds - a.offsetSeconds;
      if (span <= EPS) return b.value;
      const p = (offsetSeconds - a.offsetSeconds) / span;
      return a.value + (b.value - a.value) * applyEasing(a.easing, p);
    }
  }
  return last.value;
}

/** Insert or replace (within EPS) a keyframe; keeps the list sorted. Mutates and returns `kfs`. */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe): Keyframe[] {
  const idx = kfs.findIndex((k) => Math.abs(k.offsetSeconds - kf.offsetSeconds) <= EPS);
  if (idx >= 0) kfs[idx] = kf;
  else {
    kfs.push(kf);
    kfs.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  }
  return kfs;
}

/**
 * Split a keyframe list at `offset`. Each side receives an interpolated boundary keyframe
 * so the animation is continuous across the cut. Right-side offsets are rebased to 0.
 */
export function splitKeyframes(kfs: Keyframe[], offset: number, fallback: number): { left: Keyframe[]; right: Keyframe[] } {
  if (kfs.length === 0) return { left: [], right: [] };
  const boundaryValue = evaluateKeyframes(kfs, offset, fallback);
  // The easing of the segment containing `offset` carries over to the right boundary.
  let segEasing: Easing = kfs[kfs.length - 1].easing;
  for (let i = kfs.length - 1; i >= 0; i--) {
    if (kfs[i].offsetSeconds <= offset + EPS) {
      segEasing = kfs[i].easing;
      break;
    }
  }
  const left = kfs.filter((k) => k.offsetSeconds < offset - EPS).map((k) => ({ ...k }));
  left.push({ offsetSeconds: cleanTime(offset), value: boundaryValue, easing: { type: "linear" } });
  const right: Keyframe[] = [{ offsetSeconds: 0, value: boundaryValue, easing: { ...segEasing } }];
  for (const k of kfs) {
    if (k.offsetSeconds > offset + EPS) right.push({ ...k, offsetSeconds: cleanTime(k.offsetSeconds - offset) });
  }
  return { left, right };
}

/** Trim `amount` seconds off the head of a keyframe list (adds an interpolated keyframe at 0). */
export function trimKeyframesHead(kfs: Keyframe[], amount: number, fallback: number): Keyframe[] {
  if (kfs.length === 0) return kfs;
  if (amount <= 0) {
    // Extending the head: shift everything later.
    return kfs.map((k) => ({ ...k, offsetSeconds: cleanTime(k.offsetSeconds - amount) }));
  }
  return splitKeyframes(kfs, amount, fallback).right;
}

/** Drop keyframes after `duration`, adding an interpolated keyframe at the new end. */
export function trimKeyframesTail(kfs: Keyframe[], duration: number, fallback: number): Keyframe[] {
  if (kfs.length === 0) return kfs;
  if (kfs[kfs.length - 1].offsetSeconds <= duration + EPS) return kfs;
  return splitKeyframes(kfs, duration, fallback).left;
}

/** Scale keyframe offsets (used when speed changes the element duration). */
export function scaleKeyframes(keyframes: Keyframes, factor: number): Keyframes {
  const out: Keyframes = {};
  for (const [prop, kfs] of Object.entries(keyframes) as [KeyframeProperty, Keyframe[]][]) {
    out[prop] = kfs.map((k) => ({ ...k, offsetSeconds: cleanTime(k.offsetSeconds * factor) }));
  }
  return out;
}
